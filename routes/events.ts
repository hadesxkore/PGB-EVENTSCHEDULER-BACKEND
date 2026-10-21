import express, { Request, Response } from 'express';
import Event from '../models/Event.js';
import StatusNotification from '../models/StatusNotification.js';
import Notification from '../models/Notification.js';
import UserActivityLog from '../models/UserActivityLog.js';
import ResourceAvailability from '../models/ResourceAvailability.js';
import LocationAvailability from '../models/LocationAvailability.js';
import Department from '../models/Department.js';
import User from '../models/User.js';
import DepartmentPermissions from '../models/DepartmentPermissions.js';
import { authenticateToken } from '../middleware/auth.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/events';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});


// GET /api/events/bac/requests - List BAC-owned location requests (BAC only)
router.get('/bac/requests', authenticateToken, async (req: Request, res: Response) => {
  try {
    const department = String((req as any).user?.department || '').trim().toUpperCase();
    if (department !== 'BAC') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. BAC department only.'
      });
    }

    const location = '5th Flr. Training Room 1 (BAC)';
    const status = String(req.query.status || 'pending').toLowerCase();
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '10'), 10) || 10));
    const skip = (page - 1) * limit;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let query: any = {};

    if (status === 'pending') {
      query.location = location;
      query.status = { $in: ['submitted', 'approved'] };
      query.endDate = { $gte: today };
      query.bacApprovalStatus = { $in: ['pending', undefined, null] };
    } else if (status === 'approved') {
      query.bacApprovalStatus = 'approved';
    } else if (status === 'rejected') {
      query.bacApprovalStatus = 'rejected';
    }

    const [items, total] = await Promise.all([
      Event.find(query)
        .sort({ submittedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('createdBy', 'name email department'),
      Event.countDocuments(query)
    ]);

    return res.json({
      success: true,
      page,
      limit,
      total,
      data: items
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch BAC requests'
    });
  }
});

// PATCH /api/events/:id/bac-approval - Approve/Reject BAC-owned location request (BAC only)
router.patch('/:id/bac-approval', authenticateToken, async (req: Request, res: Response) => {
  try {
    const department = String((req as any).user?.department || '').trim().toUpperCase();
    if (department !== 'BAC') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. BAC department only.'
      });
    }

    const { id } = req.params;
    const decisionRaw = String(req.body?.decision || '').trim().toLowerCase();
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : undefined;

    if (decisionRaw !== 'approved' && decisionRaw !== 'rejected') {
      return res.status(400).json({
        success: false,
        message: 'Invalid decision. Must be approved or rejected.'
      });
    }

    const event = await Event.findById(id);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    if (String(event.location || '').trim() !== '5th Flr. Training Room 1 (BAC)') {
      return res.status(400).json({
        success: false,
        message: 'This event is not a BAC-owned location request.'
      });
    }

    const eventStatus = String(event.status || '').toLowerCase();
    if (eventStatus !== 'submitted' && eventStatus !== 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Only submitted or approved events can be processed by BAC.'
      });
    }

    const endDate = (event as any).endDate ? new Date((event as any).endDate) : null;
    if (endDate && !Number.isNaN(endDate.getTime())) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (endDate < today) {
        return res.status(400).json({
          success: false,
          message: 'Past events can no longer be processed by BAC.'
        });
      }
    }

    const bacStatus = (event as any).bacApprovalStatus;
    if (bacStatus === 'approved' || bacStatus === 'rejected') {
      return res.status(400).json({
        success: false,
        message: 'BAC decision has already been recorded for this request.'
      });
    }

    (event as any).bacApprovalStatus = decisionRaw;
    (event as any).bacApprovedBy = (req as any).user?._id;
    (event as any).bacApprovedAt = new Date();
    if (notes !== undefined) {
      (event as any).bacNotes = notes;
    }

    // AUTO-APPROVE: If BAC approves, automatically approve the event in admin side
    if (decisionRaw === 'approved') {
      (event as any).status = 'approved';
      (event as any).approvedAt = new Date();
      (event as any).approvedBy = (req as any).user?._id; // BAC user who approved
      (event as any).autoApprovedByBAC = true; // Flag to indicate it was auto-approved by BAC

      // Release department requirements so tagged departments can see the event
      const deptReqs = (event as any).departmentRequirements || {};
      for (const department in deptReqs) {
        const requirements = deptReqs[department];
        if (Array.isArray(requirements)) {
          requirements.forEach((req: any) => {
            req.requirementsStatus = 'released';
          });
        }
      }
      (event as any).markModified('departmentRequirements');
    }

    // AUTO-REJECT: If BAC rejects, automatically reject the event in admin side
    if (decisionRaw === 'rejected') {
      (event as any).status = 'rejected';
      (event as any).reason = notes || 'Rejected by BAC';
    }

    const saved = await event.save();
    await saved.populate('createdBy', 'name email department');

    const io = (req.app as any).get('io');
    if (io) {
      io.emit('bac-request-updated', {
        eventId: saved._id,
        bacApprovalStatus: (saved as any).bacApprovalStatus,
        location: saved.location
      });

      try {
        const adminUsers = await User.find({
          role: { $in: ['Admin', 'superadmin'] },
          status: 'active'
        }).select('_id name email role');

        const schedule = (() => {
          const startDateStr = saved.startDate ? new Date(saved.startDate).toISOString().split('T')[0] : '';
          const endDateStr = saved.endDate ? new Date(saved.endDate).toISOString().split('T')[0] : '';
          const startTimeStr = String(saved.startTime || '');
          const endTimeStr = String(saved.endTime || '');
          return startDateStr && startTimeStr && endDateStr && endTimeStr
            ? `${startDateStr} ${startTimeStr} - ${endDateStr} ${endTimeStr}`
            : '';
        })();

        adminUsers.forEach((a: any) => {
          const notificationMessage = decisionRaw === 'approved'
            ? `BAC has approved the request for "${saved.eventTitle}" - Event automatically approved`
            : `BAC has ${decisionRaw} the request for "${saved.eventTitle}"`;

          io.to(`user-${String(a._id)}`).emit('new-notification', {
            notificationType: 'bac-approval-update',
            type: 'bac-approval-update',
            eventId: saved._id,
            eventTitle: saved.eventTitle,
            location: saved.location,
            schedule,
            requestor: saved.requestor,
            requestorDepartment: saved.requestorDepartment,
            bacApprovalStatus: (saved as any).bacApprovalStatus,
            eventStatus: saved.status, // Include the event status
            autoApprovedByBAC: (saved as any).autoApprovedByBAC,
            message: notificationMessage,
            timestamp: Date.now()
          });
        });
      } catch (e) {
        console.error('❌ Failed to notify admins about BAC decision:', e);
      }

      // Notify the event creator (user who submitted the event)
      try {
        const creatorId = saved.createdBy?._id || saved.createdBy;
        if (creatorId) {
          const userNotificationMessage = decisionRaw === 'approved'
            ? `Your event "${saved.eventTitle}" has been approved by BAC and is now automatically approved!`
            : `Your event "${saved.eventTitle}" has been ${decisionRaw} by BAC`;

          io.to(`user-${String(creatorId)}`).emit('new-notification', {
            notificationType: 'event-status-update',
            type: 'event-status-update',
            eventId: saved._id,
            eventTitle: saved.eventTitle,
            status: saved.status,
            bacApprovalStatus: (saved as any).bacApprovalStatus,
            autoApprovedByBAC: (saved as any).autoApprovedByBAC,
            message: userNotificationMessage,
            timestamp: Date.now()
          });
        }
      } catch (e) {
        console.error('Failed to notify event creator about BAC decision:', e);
      }

      // Notify tagged departments when BAC auto-approves
      if (decisionRaw === 'approved' && saved.taggedDepartments && saved.taggedDepartments.length > 0) {
        io.emit('new-notification', {
          type: 'event_approved',
          eventId: saved._id,
          eventTitle: saved.eventTitle,
          status: 'approved',
          message: `Event "${saved.eventTitle}" has been approved`,
          timestamp: Date.now()
        });

        saved.taggedDepartments.forEach((dept: string) => {
          io.emit('status-update', {
            eventId: saved._id,
            eventTitle: saved.eventTitle,
            department: dept,
            status: 'approved',
            message: `Event "${saved.eventTitle}" has been approved. Requirements are now available for your department.`
          });
        });
      }
    }

    return res.json({
      success: true,
      message: `BAC decision recorded: ${decisionRaw}`,
      data: saved
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to update BAC decision'
    });
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per file limit (increased for production)
    files: 10, // Maximum 10 files per request
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only images and documents are allowed'));
    }
  }
});

// PATCH /api/events/:eventId/requirements/:requirementId/notes - Update requirement notes
router.patch('/:eventId/requirements/:requirementId/notes', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { eventId, requirementId } = req.params;
    const { departmentNotes } = req.body;
    const userDepartment = (req as any).user.department;

    // Find the event
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Check if user's department is tagged in this event
    if (!event.taggedDepartments.includes(userDepartment)) {
      return res.status(403).json({
        success: false,
        message: 'Your department is not tagged in this event'
      });
    }

    // Find and update the requirement
    let requirementFound = false;
    for (const [dept, requirements] of Object.entries(event.departmentRequirements) as [string, any[]][]) {
      const requirement = requirements.find(r => r.id === requirementId);
      if (requirement) {
        requirement.departmentNotes = departmentNotes;
        requirement.lastUpdated = new Date().toISOString();
        requirementFound = true;
        break;
      }
    }

    // Mark the departmentRequirements field as modified for Mongoose
    event.markModified('departmentRequirements');

    if (!requirementFound) {
      return res.status(404).json({
        success: false,
        message: 'Requirement not found'
      });
    }

    // Save the updated event
    await event.save();

    // Debug: Log the saved requirement to verify departmentNotes is saved
    const savedRequirement = Object.values(event.departmentRequirements)
      .flat()
      .find(r => r.id === requirementId);

    res.status(200).json({
      success: true,
      message: 'Requirement notes updated successfully',
      data: event
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update requirement notes',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// DELETE /api/events/:eventId/attachment/:filename - Delete an attachment file from an event
router.delete('/:eventId/attachment/:filename', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { eventId, filename } = req.params;
    const userId = (req as any).user._id;
    const userRoleRaw = (req as any).user.role;
    const userRole = (userRoleRaw || '').toString().toLowerCase();

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Check if user owns the event or is admin/superadmin
    if (event.createdBy.toString() !== userId.toString() && userRole !== 'admin' && userRole !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only edit your own events.'
      });
    }

    const filenameStr = String(filename);
    const existing = Array.isArray((event as any).attachments)
      ? (event as any).attachments.find((a: any) => a && a.filename === filenameStr)
      : null;

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Attachment not found on this event'
      });
    }

    // Remove from DB first
    (event as any).attachments = (event as any).attachments.filter((a: any) => a && a.filename !== filenameStr);
    event.markModified('attachments');
    await event.save();

    // Best-effort delete from disk
    const filePath = path.join(process.cwd(), 'uploads', 'events', filenameStr);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Don't fail request if disk cleanup fails
    }

    return res.status(200).json({
      success: true,
      message: 'Attachment deleted successfully',
      data: event
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to delete attachment',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PATCH /api/events/:eventId/requirements/:requirementId/replies - Add a reply to a requirement conversation
router.patch('/:eventId/requirements/:requirementId/replies', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { eventId, requirementId } = req.params;
    const { message, role } = req.body as { message: string; role: 'requestor' | 'department' };
    const user = (req as any).user;

    if (!message || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Reply message is required'
      });
    }

    // Find the event
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Permission checks
    const userDepartment = user.department;
    const isRequestor = user.id && event.createdBy && user.id.toString() === event.createdBy.toString();
    const isTaggedDepartment = userDepartment && event.taggedDepartments.includes(userDepartment);

    if (role === 'requestor' && !isRequestor) {
      return res.status(403).json({
        success: false,
        message: 'Only the event requestor can reply as requestor'
      });
    }

    if (role === 'department' && !isTaggedDepartment) {
      return res.status(403).json({
        success: false,
        message: 'Only tagged departments can reply as department'
      });
    }

    // Find the requirement and append reply
    let requirementFound = false;
    for (const [, requirements] of Object.entries(event.departmentRequirements) as [string, any[]][]) {
      const requirement: any = requirements.find(r => r.id === requirementId);
      if (requirement) {
        if (!Array.isArray(requirement.replies)) {
          requirement.replies = [];
        }

        requirement.replies.push({
          userId: user.id,
          userName: user.name || user.fullName || user.email || 'Unknown User',
          role,
          message: message.trim(),
          createdAt: new Date().toISOString(),
          isRead: false // Mark new replies as unread
        });

        requirement.lastUpdated = new Date().toISOString();
        requirementFound = true;
        break;
      }
    }

    if (!requirementFound) {
      return res.status(404).json({
        success: false,
        message: 'Requirement not found'
      });
    }

    event.markModified('departmentRequirements');
    await event.save();

    // Emit real-time reply update to requestor (and optionally sender)
    try {
      const io = req.app.get('io');
      if (io) {
        const eventIdStr = (event._id as any).toString();
        const latestReply = (() => {
          for (const [, requirements] of Object.entries(event.departmentRequirements) as [string, any[]][]) {
            const r: any = requirements.find(rr => rr.id === requirementId);
            if (r && Array.isArray(r.replies) && r.replies.length > 0) {
              return r.replies[r.replies.length - 1];
            }
          }
          return null;
        })();

        const replyUpdateData = {
          eventId: eventIdStr,
          requirementId,
          reply: latestReply,
          updatedEvent: event
        };

        // Notify event requestor
        io.to(`user-${event.createdBy}`).emit('reply-update', replyUpdateData);

        // Also notify the user who sent the reply (for mirror updates)
        const updatingUserId = (req as any).user.id;
        if (updatingUserId && updatingUserId.toString() !== (event.createdBy as any).toString()) {
          io.to(`user-${updatingUserId}`).emit('reply-update', replyUpdateData);
        }

        // Broadcast globally so tagged departments listening on reply-update also refresh
        io.emit('reply-update', replyUpdateData);
      }
    } catch (socketError) {
      // Don't fail the main request if socket emission fails
    }

    return res.status(200).json({
      success: true,
      message: 'Reply added successfully',
      data: event
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to add reply to requirement',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PATCH /api/events/:eventId/requirements/:requirementId/status - Update requirement status
router.patch('/:eventId/requirements/:requirementId/status', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { eventId, requirementId } = req.params;
    const { status, declineReason } = req.body;
    const userDepartment = (req as any).user.department;

    // Find the event
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Check if user's department is tagged in this event
    if (!event.taggedDepartments.includes(userDepartment)) {
      return res.status(403).json({
        success: false,
        message: 'Your department is not tagged in this event'
      });
    }

    // Find and update the requirement
    let requirementFound = false;
    let oldStatus = '';
    let requirementName = '';
    let updatedRequirement: any = null;
    
    for (const [dept, requirements] of Object.entries(event.departmentRequirements) as [string, any[]][]) {
      const requirement = requirements.find(r => r.id === requirementId);
      if (requirement) {
        oldStatus = requirement.status || 'pending';
        requirementName = requirement.name || 'Unknown Requirement';
        requirement.status = status;
        requirement.lastUpdated = new Date().toISOString();
        
        // Save decline reason if status is declined
        if (status === 'declined' && declineReason) {
          requirement.declineReason = declineReason;
        }
        
        updatedRequirement = requirement;
        requirementFound = true;
        break;
      }
    }

    // Mark the departmentRequirements field as modified for Mongoose
    event.markModified('departmentRequirements');

    if (!requirementFound) {
      return res.status(404).json({
        success: false,
        message: 'Requirement not found'
      });
    }

    // Save the updated event
    await event.save();

    // Emit real-time status update FIRST (before notification creation)
    if (oldStatus !== status) {
      const io = req.app.get('io');
      if (io) {
        const statusUpdateData = {
          eventId: event._id,
          requestorId: event.createdBy,
          departmentName: userDepartment,
          requirementName: requirementName,
          requirementId: requirementId,
          oldStatus: oldStatus,
          newStatus: status,
          departmentNotes: updatedRequirement?.departmentNotes || '',
          declineReason: status === 'declined' ? declineReason : undefined,
          type: 'status_update',
          notificationType: 'status_update'
        };
        
        // Send to event creator
        io.to(`user-${event.createdBy}`).emit('status-update', statusUpdateData);
        io.to(`user-${event.createdBy}`).emit('new-notification', {
          ...statusUpdateData,
          eventTitle: event.eventTitle,
          message: `${requirementName} status changed to "${status}" by ${userDepartment}`
        });
        
        // ALSO send to the user who made the update (for their own badge update!)
        const updatingUserId = (req as any).user.id;
        if (updatingUserId && updatingUserId.toString() !== event.createdBy.toString()) {
          io.to(`user-${updatingUserId}`).emit('status-update', statusUpdateData);
        }
      }
      
      // Then try to create notifications (non-critical)
      try {
        // Create notification in main notifications collection with unique ID
        const eventIdStr = (event._id as any).toString();
        const timestamp = Date.now();
        const notificationId = `status-${eventIdStr}-${requirementId}-${timestamp}`;
        const notification = new Notification({
          id: notificationId,
          title: "Status Updated",
          message: `"${requirementName}" status: "${status}" by ${userDepartment} for event "${event.eventTitle}"`,
          type: "status",
          category: "status",
          eventId: eventIdStr,
          requirementId: requirementId,
          departmentNotes: updatedRequirement?.departmentNotes || '',
          userId: (event.createdBy as any).toString()
        });

        await notification.save();

        // Keep the old StatusNotification for backward compatibility (optional)
        const statusNotification = new StatusNotification({
          eventId: event._id,
          requestorId: event.createdBy,
          departmentName: userDepartment,
          requirementName: requirementName,
          requirementId: requirementId,
          oldStatus: oldStatus,
          newStatus: status,
          departmentNotes: updatedRequirement?.departmentNotes || '',
          updatedBy: (req as any).user.id
        });

        await statusNotification.save();
      } catch (notificationError) {
        // Don't fail the main request if notification creation fails
      }
    }

    // Verify status was saved successfully
    const savedRequirement = Object.values(event.departmentRequirements)
      .flat()
      .find((r: any) => r.id === requirementId);

    res.status(200).json({
      success: true,
      message: 'Requirement status updated successfully',
      data: event
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update event status',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PATCH /api/events/:eventId/requirements/:requirementId/departments - Change requirement department tags
router.patch('/:eventId/requirements/:requirementId/departments', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { eventId, requirementId } = req.params;
    const { departments } = req.body;
    
    if (!Array.isArray(departments) || departments.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Departments array is required and cannot be empty'
      });
    }

    // Find the event
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Find the requirement in current departments
    let requirement: any = null;
    let oldDepartment: string = '';
    
    for (const [dept, requirements] of Object.entries(event.departmentRequirements) as [string, any[]][]) {
      const foundReq = requirements.find(r => r.id === requirementId);
      if (foundReq) {
        requirement = foundReq;
        oldDepartment = dept;
        // Remove from old department
        event.departmentRequirements[dept] = requirements.filter(r => r.id !== requirementId);
        if (event.departmentRequirements[dept].length === 0) {
          delete event.departmentRequirements[dept];
        }
        break;
      }
    }

    if (!requirement) {
      return res.status(404).json({
        success: false,
        message: 'Requirement not found'
      });
    }

    // Add requirement to new department(s)
    // IMPORTANT: clone + reset dept-specific fields so conversation/decline notes don't leak
    // across departments when a requirement is re-assigned.
    const baseRequirement = {
      ...(requirement || {}),
      departmentNotes: '',
      notes: '',
      replies: [],
      status: 'pending',
      lastUpdated: new Date().toISOString()
    };

    // Some older records may have extra fields (e.g., decline reason fields) that should not carry over.
    // Strip common variants if present.
    delete (baseRequirement as any).departmentNote;
    delete (baseRequirement as any).note;
    delete (baseRequirement as any).declineReason;
    delete (baseRequirement as any).declinedReason;
    delete (baseRequirement as any).reason;
    delete (baseRequirement as any).declinedAt;
    delete (baseRequirement as any).declinedBy;

    for (const newDept of departments) {
      if (!event.departmentRequirements[newDept]) {
        event.departmentRequirements[newDept] = [];
      }
      // Clone per-department so arrays don't share object references.
      event.departmentRequirements[newDept].push({ ...baseRequirement });
    }

    // Update tagged departments list - ONLY include departments that have requirements
    const allDepts = Object.keys(event.departmentRequirements);
    event.taggedDepartments = allDepts; // Replace entire array with only departments that have requirements

    // Mark as modified for Mongoose
    event.markModified('departmentRequirements');
    event.markModified('taggedDepartments');

    // Save the event
    await event.save();

    res.status(200).json({
      success: true,
      message: 'Department tags updated successfully',
      data: event
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update department tags',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/events/:eventId/add-department - Add department with requirements to existing event
router.post('/:eventId/add-department', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    const { departmentName, requirements } = req.body;

    if (!departmentName || !Array.isArray(requirements) || requirements.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Department name and requirements array are required'
      });
    }

    // Find the event
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Initialize departmentRequirements if it doesn't exist
    if (!event.departmentRequirements) {
      event.departmentRequirements = {};
    }

    // Add or update requirements for this department
    if (!event.departmentRequirements[departmentName]) {
      event.departmentRequirements[departmentName] = [];
    }

    // Add new requirements (filter out duplicates by name)
    requirements.forEach((newReq: any) => {
      if (newReq.selected) {
        const existingReq = event.departmentRequirements[departmentName].find(
          (r: any) => r.name === newReq.name
        );
        
        if (!existingReq) {
          // Add new requirement with availability info
          event.departmentRequirements[departmentName].push({
            id: newReq.id,
            name: newReq.name,
            type: newReq.type,
            selected: true,
            quantity: newReq.quantity || undefined,
            notes: newReq.notes || '',
            totalQuantity: newReq.totalQuantity || newReq.baseQuantity || undefined,
            isAvailable: newReq.isAvailable,
            availabilityNotes: newReq.availabilityNotes || '',
            status: 'pending'
          });
        }
      }
    });

    // Update tagged departments list
    if (!event.taggedDepartments.includes(departmentName)) {
      event.taggedDepartments.push(departmentName);
    }

    // Mark as modified for Mongoose
    event.markModified('departmentRequirements');
    event.markModified('taggedDepartments');

    // Save the event
    await event.save();

    res.status(200).json({
      success: true,
      message: 'Department added successfully',
      data: event
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to add department',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PATCH /api/events/:id/status - Update event status (Admin only - Approve/Reject)
router.patch('/:id/status', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;
    
    // Validate status
    if (!['approved', 'rejected', 'submitted', 'cancelled'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be approved, rejected, submitted, or cancelled'
      });
    }
    
    // Prepare update object
    const updateData: any = { status };
    
    // Add reason if provided (for rejected or cancelled status)
    if (reason && (status === 'rejected' || status === 'cancelled')) {
      updateData.reason = reason;
    }
    
    // Find the event first to check if it's being cancelled
    const event = await Event.findById(id);
    
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Permission rules:
    // - Admin/superadmin or PGSO (or users with allEvents permission) can approve/reject/cancel.
    // - Requestor (event owner) can ONLY cancel, and only before approval.
    const user = (req as any).user;
    const userRole = String(user?.role || '').toLowerCase();
    const userDepartment = String(user?.department || '').trim().toUpperCase();
    const isAdmin = userRole === 'admin' || userRole === 'superadmin';
    const isPgso = userDepartment === 'PGSO';

    let hasAllEventsAccess = isAdmin || isPgso;
    if (!hasAllEventsAccess && userDepartment) {
      const deptPerm = await DepartmentPermissions.findOne({ department: userDepartment });
      if (deptPerm?.permissions?.allEvents) {
        hasAllEventsAccess = true;
      }
    }
    const isOwner = user?._id && event.createdBy && event.createdBy.toString() === user._id.toString();

    if (!hasAllEventsAccess) {
      if (!isOwner) {
        return res.status(403).json({
          success: false,
          message: 'You can only update status for your own events'
        });
      }

      if (status !== 'cancelled') {
        return res.status(403).json({
          success: false,
          message: 'You are only allowed to cancel your own event before approval'
        });
      }

      // Requestor cancellation rules:
      // - allow cancelling approved/submitted/draft events
      // - disallow cancelling completed/cancelled events
      // - disallow cancelling past events (by endDate)
      const currentStatus = String(event.status || '').toLowerCase();
      if (currentStatus === 'completed' || currentStatus === 'cancelled') {
        return res.status(400).json({
          success: false,
          message: 'This event can no longer be cancelled'
        });
      }

      const endDate = (event as any).endDate ? new Date((event as any).endDate) : null;
      if (endDate && !Number.isNaN(endDate.getTime())) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (endDate < today) {
          return res.status(400).json({
            success: false,
            message: 'Past events can no longer be cancelled.'
          });
        }
      }
    }
    
    // If approving the event, RELEASE requirements to departments
    if (status === 'approved') {
      // Release all department requirements (change from on-hold to released)
      const departmentRequirements = event.departmentRequirements || {};
      
      for (const department in departmentRequirements) {
        const requirements = departmentRequirements[department];
        if (Array.isArray(requirements)) {
          requirements.forEach((req: any) => {
            req.requirementsStatus = 'released'; // Release requirements to departments
          });
        }
      }
      
      updateData.departmentRequirements = departmentRequirements;
    }
    
    // If cancelling the event, reset all department requirements
    if (status === 'cancelled') {
      // Reset all department requirements to pending
      const departmentRequirements = event.departmentRequirements || {};
      
      for (const department in departmentRequirements) {
        const requirements = departmentRequirements[department];
        if (Array.isArray(requirements)) {
          requirements.forEach((req: any) => {
            req.status = 'pending';
            req.declineReason = undefined;
            req.notes = undefined;
          });
        }
      }
      
      updateData.departmentRequirements = departmentRequirements;

      // If requestor cancelled and no reason provided, use a default
      if (!hasAllEventsAccess && isOwner && (!reason || !String(reason).trim())) {
        updateData.reason = 'Requestor cancelled';
      }

      // Record who cancelled and when (audit trail)
      updateData.cancelledBy = {
        userId: user._id,
        name: user.name || user.username || 'Unknown',
        email: user.email || '',
        role: user.role || 'user'
      };
      updateData.cancelledAt = new Date();
    }
    
    // Update the event
    const updatedEvent = await Event.findByIdAndUpdate(
      id,
      updateData,
      { new: true }
    ).populate('createdBy', 'name email department');

    // Create a persistent notification for the requestor so it appears in the Notifications page
    try {
      const requestorId = (event.createdBy as any)?.toString?.() || String(event.createdBy);

      const tz = 'Asia/Manila';
      const toDateOnly = (d: any): string | null => {
        if (!d) return null;
        const asDate = d instanceof Date ? d : new Date(d);
        if (isNaN(asDate.getTime())) return null;
        return asDate.toISOString().split('T')[0];
      };
      const formatSchedule = (startD: any, startT: string, endD: any, endT: string) => {
        const sd = toDateOnly(startD);
        const ed = toDateOnly(endD);
        if (!sd || !ed) return '';
        const sDate = new Date(`${sd}T00:00:00`);
        const eDate = new Date(`${ed}T00:00:00`);
        const sDateStr = sDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz });
        const eDateStr = eDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz });
        return `${sDateStr} ${startT} - ${eDateStr} ${endT}`;
      };

      const schedule = formatSchedule(
        (updatedEvent as any)?.startDate || event.startDate,
        (updatedEvent as any)?.startTime || event.startTime,
        (updatedEvent as any)?.endDate || event.endDate,
        (updatedEvent as any)?.endTime || event.endTime
      );

      const extras: string[] = [];
      const requestorDept = (updatedEvent as any)?.requestorDepartment || (event as any).requestorDepartment;
      if (requestorDept) extras.push(`Department: ${requestorDept}`);
      if ((updatedEvent as any)?.location || event.location) extras.push(`Location: ${(updatedEvent as any)?.location || event.location}`);
      if (schedule) extras.push(`Schedule: ${schedule}`);

      const notifId = `event-status-${String(event._id)}-${String(status)}-${Date.now()}`;
      await Notification.create({
        id: notifId,
        title: 'Event Status Updated',
        message: `Your event "${event.eventTitle}" has been ${status}${extras.length ? `\n${extras.join('\n')}` : ''}`,
        type: 'status',
        category: 'status',
        eventId: String(event._id),
        eventDate: event.startDate ? event.startDate.toISOString() : undefined,
        userId: requestorId
      });
    } catch (persistError) {
      // Non-critical
    }
    
    // Emit Socket.IO event for real-time updates
    const io = req.app.get('io');
    if (io) {
      // Get admin/updater name for notification
      const adminUser = (req as any).user;
      const adminName = adminUser?.name || adminUser?.username || (isAdmin ? 'Admin' : isPgso ? 'PGSO' : 'Department Admin');

      const tz = 'Asia/Manila';
      const toDateOnly = (d: any): string | null => {
        if (!d) return null;
        const asDate = d instanceof Date ? d : new Date(d);
        if (isNaN(asDate.getTime())) return null;
        return asDate.toISOString().split('T')[0];
      };
      const formatSchedule = (startD: any, startT: string, endD: any, endT: string) => {
        const sd = toDateOnly(startD);
        const ed = toDateOnly(endD);
        if (!sd || !ed) return '';
        const sDate = new Date(`${sd}T00:00:00`);
        const eDate = new Date(`${ed}T00:00:00`);
        const sDateStr = sDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz });
        const eDateStr = eDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz });
        return `${sDateStr} ${startT} - ${eDateStr} ${endT}`;
      };
      
      // Notify the event creator with new-notification event (for GlobalNotificationSystem)
      io.to(`user-${event.createdBy}`).emit('new-notification', {
        type: 'event_status_update',
        eventId: event._id,
        eventTitle: event.eventTitle,
        eventStatus: status,
        status: status,
        adminName: adminName,
        updatedBy: adminName,
        message: `Your event "${event.eventTitle}" has been ${status} by ${adminName}`,
        createdBy: (event.createdBy as any)?.toString?.() || String(event.createdBy),
        requestor: (updatedEvent as any)?.createdBy?.name || (updatedEvent as any)?.createdBy?.username || (updatedEvent as any)?.createdBy?.email,
        requestorEmail: (updatedEvent as any)?.createdBy?.email,
        requestorDepartment: (updatedEvent as any)?.createdBy?.department || (updatedEvent as any)?.requestorDepartment || (event as any).requestorDepartment,
        location: (updatedEvent as any)?.location || event.location,
        startDate: (updatedEvent as any)?.startDate ? (updatedEvent as any).startDate.toISOString() : (event.startDate ? event.startDate.toISOString() : undefined),
        startTime: (updatedEvent as any)?.startTime || event.startTime,
        endDate: (updatedEvent as any)?.endDate ? (updatedEvent as any).endDate.toISOString() : (event.endDate ? event.endDate.toISOString() : undefined),
        endTime: (updatedEvent as any)?.endTime || event.endTime,
        schedule: formatSchedule(
          (updatedEvent as any)?.startDate || event.startDate,
          (updatedEvent as any)?.startTime || event.startTime,
          (updatedEvent as any)?.endDate || event.endDate,
          (updatedEvent as any)?.endTime || event.endTime
        ),
        timestamp: Date.now()
      });
      
      // Also emit old event for backward compatibility
      io.to(`user-${event.createdBy}`).emit('event-status-updated', {
        eventId: event._id,
        eventTitle: event.eventTitle,
        status: status,
        message: `Your event "${event.eventTitle}" has been ${status}`
      });
      
      // Broadcast to all admins
      io.emit('event-updated', updatedEvent);
      
      // If approved, notify all tagged departments that requirements are now released
      if (status === 'approved' && updatedEvent!.taggedDepartments) {
        // Emit to all users (for real-time dashboard updates)
        io.emit('new-notification', {
          type: 'event_approved',
          eventId: updatedEvent!._id,
          eventTitle: updatedEvent!.eventTitle,
          status: 'approved',
          message: `Event "${updatedEvent!.eventTitle}" has been approved`,
          timestamp: Date.now()
        });
        
        // Also emit status-update for backward compatibility
        updatedEvent!.taggedDepartments.forEach((dept: string) => {
          io.emit('status-update', {
            eventId: updatedEvent!._id,
            eventTitle: updatedEvent!.eventTitle,
            department: dept,
            status: 'approved',
            message: `Event "${updatedEvent!.eventTitle}" has been approved. Requirements are now available for your department.`
          });
        });
      }
      
      // If cancelled, notify all tagged departments about requirement reset
      if (status === 'cancelled' && updatedEvent!.taggedDepartments) {
        updatedEvent!.taggedDepartments.forEach((dept: string) => {
          io.emit('status-update', {
            eventId: updatedEvent!._id,
            eventTitle: updatedEvent!.eventTitle,
            department: dept,
            message: `Event "${updatedEvent!.eventTitle}" has been cancelled. All requirements have been reset.`
          });
        });
      }
    }
    
    res.status(200).json({
      success: true,
      message: `Event ${status} successfully`,
      data: updatedEvent
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update event status',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PATCH /api/events/:id/details - Update event details (for on-hold/submitted events)
router.patch('/:id/details', authenticateToken, upload.fields([
  { name: 'attachments', maxCount: 10 },
  { name: 'brieferTemplate', maxCount: 1 },
  { name: 'availableForDL', maxCount: 1 },
  { name: 'programme', maxCount: 1 }
]), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { eventTitle, requestor, participants, vip, vvip, contactNumber, contactEmail, description } = req.body;
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    
    // Find the event
    const event = await Event.findById(id);
    
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }
    
    // Check if user owns this event
    const userId = (req as any).user._id;
    if (event.createdBy.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You can only edit your own events'
      });
    }
    
    // Allow editing if event is submitted or approved (but not completed/cancelled/rejected)
    if (event.status !== 'submitted' && event.status !== 'approved') {
      return res.status(400).json({
        success: false,
        message: 'You can only edit details of submitted or approved events'
      });
    }
    
    // Validate required fields
    if (!eventTitle || !requestor || !contactEmail || !contactNumber) {
      return res.status(400).json({
        success: false,
        message: 'Event title, requestor, contact email, and contact number are required'
      });
    }
    
    if (participants < 1) {
      return res.status(400).json({
        success: false,
        message: 'Participants must be at least 1'
      });
    }
    
    // Update the event details
    const updateData: any = {
      eventTitle,
      requestor,
      participants: parseInt(participants),
      contactNumber,
      contactEmail
    };
    
    // Optional fields
    if (vip !== undefined) updateData.vip = parseInt(vip);
    if (vvip !== undefined) updateData.vvip = parseInt(vvip);
    if (description !== undefined) updateData.description = description;
    
    // Handle file uploads - APPEND to existing files
    if (files) {
      // Add new attachments to existing ones
      if (files.attachments && files.attachments.length > 0) {
        const newAttachments = files.attachments.map(file => ({
          filename: file.filename,
          originalName: file.originalname,
          mimetype: file.mimetype,
          size: file.size
        }));
        
        // Append to existing attachments
        updateData.attachments = [...(event.attachments || []), ...newAttachments];
      }
      
      // Handle government files - update or add
      if (!updateData.govFiles) {
        updateData.govFiles = event.govFiles || {};
      }
      
      if (files.brieferTemplate && files.brieferTemplate[0]) {
        updateData.govFiles.brieferTemplate = {
          filename: files.brieferTemplate[0].filename,
          originalName: files.brieferTemplate[0].originalname,
          mimetype: files.brieferTemplate[0].mimetype,
          size: files.brieferTemplate[0].size
        };
      }
      
      if (files.availableForDL && files.availableForDL[0]) {
        updateData.govFiles.availableForDL = {
          filename: files.availableForDL[0].filename,
          originalName: files.availableForDL[0].originalname,
          mimetype: files.availableForDL[0].mimetype,
          size: files.availableForDL[0].size
        };
      }
      
      if (files.programme && files.programme[0]) {
        updateData.govFiles.programme = {
          filename: files.programme[0].filename,
          originalName: files.programme[0].originalname,
          mimetype: files.programme[0].mimetype,
          size: files.programme[0].size
        };
      }
    }
    
    const updatedEvent = await Event.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    ).populate('createdBy', 'name email department');
    
    // Emit Socket.IO event to notify the user
    const io = (req as any).io;
    if (io) {
      io.to(`user-${userId}`).emit('event-updated', {
        eventId: updatedEvent!._id,
        eventTitle: updatedEvent!.eventTitle,
        message: `Event details updated successfully`
      });
    }
    
    res.json({
      success: true,
      message: 'Event details updated successfully',
      data: updatedEvent
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update event details',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/events/tagged - Fetch events where user's department is tagged
router.get('/tagged', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userDepartment = (req as any).user.department;

    if (!userDepartment) {
      return res.status(400).json({
        success: false,
        message: 'User department not found'
      });
    }

    const events = await Event.find({
      taggedDepartments: userDepartment,
      status: { $in: ['approved', 'completed', 'cancelled'] } // Include cancelled so departments see cancelled tagged events
    })
    .populate('createdBy', 'name email department')
    .sort({ 
      status: 1, // Approved (0) comes before completed (1) alphabetically
      startDate: 1 // Then sort by start date (earliest first)
    })
    .lean(); // Bypass Mongoose cache and get fresh data from MongoDB

    // Recalculate availability for each event based on current startDate
    const eventsWithUpdatedAvailability = await Promise.all(events.map(async (event: any) => {
      const eventDate = new Date(event.startDate).toISOString().split('T')[0]; // Format: YYYY-MM-DD
      
      // Get department requirements for this event
      const departmentRequirements = event.departmentRequirements || {};
      
      // Update availability for ALL departments (not just user's department)
      for (const deptName in departmentRequirements) {
        const requirements = departmentRequirements[deptName];
        
        const updatedRequirements = await Promise.all(
          requirements.map(async (req: any) => {
            // Find the department to get the requirement details
            const department = await Department.findOne({ name: deptName });
            if (!department) {
              return req;
            }
            
            // Find the requirement in the department
            const deptReq = department.requirements.find((r: any) => r.text === req.name);
            if (!deptReq) {
              return req;
            }
            
            // Check if there's a custom availability for this date
            const availability = await ResourceAvailability.findOne({
              departmentId: department._id,
              requirementId: deptReq._id,
              date: eventDate
            });
            
            const oldQuantity = req.totalQuantity;
            
            // Update totalQuantity based on availability or default
            if (availability) {
              req.totalQuantity = availability.quantity;
            } else if (deptReq.totalQuantity) {
              req.totalQuantity = deptReq.totalQuantity;
            }
            
            return req;
          })
        );
        
        departmentRequirements[deptName] = updatedRequirements;
      }
      
      return {
        ...event,
        departmentRequirements
      };
    }));

    res.status(200).json({
      success: true,
      count: eventsWithUpdatedAvailability.length,
      data: eventsWithUpdatedAvailability
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tagged events',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/events - Fetch all events (Admin only)
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const events = await Event.find()
      .populate('createdBy', 'name email department')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: events.length,
      data: events
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch events',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/events/my - Fetch user's events
router.get('/my', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const recalcAvailability = String((req.query as any)?.recalcAvailability ?? 'true').toLowerCase() !== 'false';

    const events = await Event.find({ createdBy: userId })
      .populate('createdBy', 'name email department')
      .sort({ createdAt: -1 })
      .lean();

    // Disabled verbose logging
    // console.log(`📋 Found ${events.length} user events`);

    // Optional: Recalculate availability for each event based on current startDate
    // This is expensive (many DB lookups). For list screens (My Events / Reports / Sidebar badges),
    // callers can skip it by passing ?recalcAvailability=false.
    if (!recalcAvailability) {
      return res.status(200).json({
        success: true,
        count: events.length,
        data: events
      });
    }

    const eventsWithUpdatedAvailability = await Promise.all(events.map(async (event: any) => {
      const eventDate = new Date(event.startDate).toISOString().split('T')[0]; // Format: YYYY-MM-DD
      // Disabled verbose logging
      // console.log(`🔄 [MY EVENTS] Recalculating availability for: ${event.eventTitle}, Date: ${eventDate}`);
      
      // Get department requirements for this event
      const departmentRequirements = event.departmentRequirements || {};
      
      // Update availability for ALL departments
      for (const deptName in departmentRequirements) {
        const requirements = departmentRequirements[deptName];
        
        const updatedRequirements = await Promise.all(
          requirements.map(async (req: any) => {
            // Find the department to get the requirement details
            const department = await Department.findOne({ name: deptName });
            if (!department) {
              // Disabled verbose logging
              // console.log(`⚠️ [MY EVENTS] Department not found: ${deptName}`);
              return req;
            }
            
            // Find the requirement in the department
            const deptReq = department.requirements.find((r: any) => r.text === req.name);
            if (!deptReq) {
              return req;
            }
            
            // Check if there's a custom availability for this date
            const availability = await ResourceAvailability.findOne({
              departmentId: department._id,
              requirementId: deptReq._id,
              date: eventDate
            });
            
            const oldQuantity = req.totalQuantity;
            
            // Update totalQuantity based on availability or default
            if (availability) {
              req.totalQuantity = availability.quantity;
              // Disabled verbose logging
              // console.log(`✅ [MY EVENTS] ${deptName} - ${req.name}: Updated from ${oldQuantity} to ${availability.quantity} (custom for ${eventDate})`);
            } else if (deptReq.totalQuantity) {
              req.totalQuantity = deptReq.totalQuantity;
              // Disabled verbose logging
              // console.log(`📋 [MY EVENTS] ${deptName} - ${req.name}: Using default ${deptReq.totalQuantity} (no custom for ${eventDate})`);
            }
            
            return req;
          })
        );
        
        departmentRequirements[deptName] = updatedRequirements;
      }
      
      return {
        ...event,
        departmentRequirements
      };
    }));

    res.status(200).json({
      success: true,
      count: eventsWithUpdatedAvailability.length,
      data: eventsWithUpdatedAvailability
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch events',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/events/:id - Get single event
router.get('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const event = await Event.findById(id).populate('createdBy', 'name email department');

    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    res.status(200).json({
      success: true,
      data: event
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch event',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/events - Create a new event request
router.post('/', authenticateToken, upload.fields([
  { name: 'attachments', maxCount: 10 },
  { name: 'brieferTemplate', maxCount: 1 },
  { name: 'availableForDL', maxCount: 1 },
  { name: 'programme', maxCount: 1 }
]), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    
    // Parse form data
    const {
      eventTitle,
      requestor,
      requestorDepartment,
      location,
      roomType,
      participants,
      vip,
      vvip,
      withoutGov,
      multipleLocations,
      description,
      startDate,
      startTime,
      endDate,
      endTime,
      dateTimeSlots,
      contactNumber,
      contactEmail,
      taggedDepartments,
      departmentRequirements,
      noAttachments,
      eventType,
      locations,
      usedAutoSuggest
    } = req.body;

    // Parse locations array if it exists (for multiple conference rooms)
    let locationsArray: string[] | undefined = undefined;
    if (locations) {
      try {
        locationsArray = JSON.parse(locations);
      } catch (e) {
        // Failed to parse locations
      }
    }

    // Parse dateTimeSlots array if it exists (for multi-day events)
    let dateTimeSlotsArray: any[] | undefined = undefined;
    if (dateTimeSlots) {
      try {
        const parsedSlots = JSON.parse(dateTimeSlots);
        // Convert date strings to Date objects
        dateTimeSlotsArray = parsedSlots.map((slot: any) => ({
          startDate: new Date(slot.startDate),
          startTime: slot.startTime,
          endDate: new Date(slot.endDate),
          endTime: slot.endTime
        }));
      } catch (e) {
        // Failed to parse dateTimeSlots
      }
    }

    // Validate required fields
    const requiredFields = {
      eventTitle,
      requestor,
      requestorDepartment,
      location,
      participants,
      startDate,
      startTime,
      endDate,
      endTime,
      contactNumber,
      contactEmail
    };

    const missingFields = Object.entries(requiredFields)
      .filter(([key, value]) => !value)
      .map(([key]) => key);

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`
      });
    }

    // Process attachments
    const attachments = files.attachments ? files.attachments.map(file => ({
      filename: file.filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      uploadedAt: new Date()
    })) : [];

    // Process government files (if w/o gov is true)
    let govFiles: any = undefined;
    if (withoutGov === 'true') {
      govFiles = {};
      
      if (files.brieferTemplate) {
        const file = files.brieferTemplate[0];
        govFiles.brieferTemplate = {
          filename: file.filename,
          originalName: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          uploadedAt: new Date()
        };
      }
      
      if (files.availableForDL) {
        const file = files.availableForDL[0];
        govFiles.availableForDL = {
          filename: file.filename,
          originalName: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          uploadedAt: new Date()
        };
      }
      
      if (files.programme) {
        const file = files.programme[0];
        govFiles.programme = {
          filename: file.filename,
          originalName: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          uploadedAt: new Date()
        };
      }
    }

    // Create new event
    const newEvent = new Event({
      eventTitle,
      requestor,
      requestorDepartment,
      location,
      locations: locationsArray,
      roomType: roomType || undefined,
      participants: parseInt(participants),
      vip: vip ? parseInt(vip) : 0,
      vvip: vvip ? parseInt(vvip) : 0,
      withoutGov: withoutGov === 'true',
      multipleLocations: multipleLocations === 'true',
      description: description || '',
      startDate: new Date(startDate),
      startTime,
      endDate: new Date(endDate),
      endTime,
      dateTimeSlots: dateTimeSlotsArray,
      contactNumber,
      contactEmail,
      attachments,
      noAttachments: noAttachments === 'true',
      govFiles,
      taggedDepartments: taggedDepartments ? JSON.parse(taggedDepartments) : [],
      departmentRequirements: departmentRequirements ? JSON.parse(departmentRequirements) : {},
      eventType: eventType || 'simple',
      usedAutoSuggest: usedAutoSuggest === 'true',
      status: 'submitted',
      bacApprovalStatus: String(location || '').trim() === '5th Flr. Training Room 1 (BAC)' ? 'pending' : undefined,
      submittedAt: new Date(),
      createdBy: userId
    });

    const savedEvent = await newEvent.save();
    await savedEvent.populate('createdBy', 'name email department');

    // 📍 AUTO-CREATE LOCATION AVAILABILITY FOR CUSTOM LOCATIONS
    const predefinedLocations = [
      'Atrium', 'AVR', 'Canteen', 'Covered Court', 'Function Hall',
      'Gymnasium', 'Lobby', 'Open Court', 'Oval', 'Parking Area',
      'Quadrangle', 'Rooftop'
    ];
    
    if (location && !predefinedLocations.includes(location)) {
      
      try {
        const eventDate = new Date(startDate).toISOString().split('T')[0];
        const userDepartment = (req as any).user.department || 'Unknown';
        
        // Check if availability already exists for this location and date
        const existingAvailability = await LocationAvailability.findOne({
          date: eventDate,
          locationName: location
        });
        
        if (!existingAvailability) {
          const newLocation = await LocationAvailability.create({
            date: eventDate,
            locationName: location,
            capacity: 1, // Minimum capacity (N/A)
            description: 'Auto-created from event request',
            status: 'available',
            setBy: userId,
            departmentName: userDepartment
          });
        }
      } catch (locationError) {
        // Don't fail the event creation if location availability fails
      }
    }

    // 🔔 EMIT SOCKET.IO EVENT FOR REAL-TIME UPDATES
    // Emit to all connected admin users so they see new submitted events in real-time
    const io = (req.app as any).get('io');
    if (io) {
      const eventData = savedEvent.toObject();
      console.log('📡 About to emit event-created:', {
        eventTitle: eventData.eventTitle,
        status: eventData.status,
        connectedClients: io.engine.clientsCount
      });
      
      // Broadcast to all connected clients using multiple methods to ensure delivery
      io.emit('event-created', eventData);
      
      // Also emit to all sockets in the default namespace
      io.of('/').emit('event-created', eventData);

      // Notify BAC department in real-time for BAC-owned location
      if (String(location || '').trim() === '5th Flr. Training Room 1 (BAC)') {
        try {
          const bacUsers = await User.find({
            department: 'BAC',
            status: 'active'
          }).select('_id name email department');

          const eventTitleStr = String(eventData.eventTitle || 'Event');
          const requestorDeptStr = String(eventData.requestorDepartment || 'Unknown');
          const requestorStr = String(eventData.requestor || 'Unknown');
          const startDateStr = eventData.startDate ? new Date(eventData.startDate).toISOString().split('T')[0] : '';
          const endDateStr = eventData.endDate ? new Date(eventData.endDate).toISOString().split('T')[0] : '';
          const startTimeStr = String(eventData.startTime || '');
          const endTimeStr = String(eventData.endTime || '');
          const schedule = startDateStr && startTimeStr && endDateStr && endTimeStr
            ? `${startDateStr} ${startTimeStr} - ${endDateStr} ${endTimeStr}`
            : '';

          bacUsers.forEach((u: any) => {
            io.to(`user-${String(u._id)}`).emit('new-notification', {
              notificationType: 'bac-location-request',
              type: 'bac-location-request',
              eventId: eventData._id,
              eventTitle: eventTitleStr,
              location: String(location),
              schedule,
              requestor: requestorStr,
              requestorDepartment: requestorDeptStr,
              message: `New request for BAC location: "${eventTitleStr}"`,
              timestamp: Date.now()
            });
          });
        } catch (e) {
          console.error('❌ Failed to emit BAC location notification:', e);
        }
      }
      
      console.log('✅ Socket.IO event-created emitted successfully for event:', savedEvent.eventTitle);
    } else {
      console.error('❌ Socket.IO instance not found in app');
    }

    res.status(201).json({
      success: true,
      message: 'Event request submitted successfully',
      data: savedEvent
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create event request',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/events/:id/status - Update event status (Admin and PGSO)
router.put('/:id/status', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const user = (req as any).user;
    const userRole = String(user?.role || '').toLowerCase();
    const userDepartment = String(user?.department || '').trim().toUpperCase();
    const isAdmin = userRole === 'admin' || userRole === 'superadmin';
    const isPgso = userDepartment === 'PGSO';

    let hasAllEventsAccess = isAdmin || isPgso;
    if (!hasAllEventsAccess && userDepartment) {
      const deptPerm = await DepartmentPermissions.findOne({ department: userDepartment });
      if (deptPerm?.permissions?.allEvents) {
        hasAllEventsAccess = true;
      }
    }

    // Check if user is admin or PGSO
    if (!hasAllEventsAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Admin or PGSO privileges required.'
      });
    }

    const validStatuses = ['draft', 'submitted', 'approved', 'rejected', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be one of: ' + validStatuses.join(', ')
      });
    }

    const event = await Event.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    ).populate('createdBy', 'name email department');

    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Event status updated successfully',
      data: event
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update event status',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// DELETE /api/events/:id - Delete event
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user._id;
    const userRoleRaw = (req as any).user.role;
    const userRole = (userRoleRaw || '').toString().toLowerCase();

    const event = await Event.findById(id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Check if user owns the event or is admin/superadmin
    if (event.createdBy.toString() !== userId && userRole !== 'admin' && userRole !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only delete your own events.'
      });
    }

    await Event.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: 'Event deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete event',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/events/attachment/:filename - Serve attachment files
router.get('/attachment/:filename', (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const { download } = req.query;
    const downloadFlag = Array.isArray(download) ? download[0] : download;
    const filePath = path.join(process.cwd(), 'uploads', 'events', String(filename));
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'File not found',
        requestedPath: filePath
      });
    }
    
    // If download=true, force download with Content-Disposition header
    if (downloadFlag === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="${String(filename)}"`);
    }
    
    // Serve the file
    res.sendFile(filePath);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to serve attachment',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/events/:id - Update event details (location, dates, times)
router.put('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { location, locations, multipleLocations, startDate, startTime, endDate, endTime, dateTimeSlots, departmentRequirements } = req.body;
    const userId = (req as any).user._id;

    // Parse locations if it's a JSON string (from FormData) or use as-is if already an array
    let locationsArray: string[] | undefined = undefined;
    if (locations) {
      if (typeof locations === 'string') {
        try {
          locationsArray = JSON.parse(locations);
        } catch (e) {
          console.error('Failed to parse locations string:', e);
        }
      } else if (Array.isArray(locations)) {
        locationsArray = locations;
      }
    }

    // Find the event and check ownership
    const event = await Event.findById(id);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Check if user owns this event
    if (event.createdBy.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only edit your own events.'
      });
    }

    // Check if this is a reschedule (date/time/location changes)
    const normalizeSlotsForCompare = (slots: any) => {
      if (!Array.isArray(slots)) return [];
      return slots
        .map((s) => {
          const sd = s?.startDate ? new Date(s.startDate) : null;
          const ed = s?.endDate ? new Date(s.endDate) : null;
          return {
            startDate: sd ? sd.toISOString().split('T')[0] : null,
            startTime: s?.startTime ?? null,
            endDate: ed ? ed.toISOString().split('T')[0] : null,
            endTime: s?.endTime ?? null
          };
        })
        .filter((s) => s.startDate && s.startTime && s.endDate && s.endTime);
    };

    const nextSlotsNormalized = dateTimeSlots !== undefined ? normalizeSlotsForCompare(dateTimeSlots) : null;
    const currentSlotsNormalized = normalizeSlotsForCompare((event as any).dateTimeSlots);
    const slotsChanged = nextSlotsNormalized ? JSON.stringify(nextSlotsNormalized) !== JSON.stringify(currentSlotsNormalized) : false;

    const isReschedule = (
      (location !== undefined && location !== event.location) ||
      (startDate !== undefined && startDate !== event.startDate?.toISOString().split('T')[0]) ||
      (startTime !== undefined && startTime !== event.startTime) ||
      (endDate !== undefined && endDate !== event.endDate?.toISOString().split('T')[0]) ||
      (endTime !== undefined && endTime !== event.endTime) ||
      slotsChanged
    );
    
    const parseDateOnly = (value: any): Date | null => {
      if (typeof value !== 'string') return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const d = new Date(`${value}T00:00:00`);
      return isNaN(d.getTime()) ? null : d;
    };

    const parsedStartDate = startDate !== undefined ? (parseDateOnly(startDate) || new Date(startDate)) : null;
    const parsedEndDate = endDate !== undefined ? (parseDateOnly(endDate) || new Date(endDate)) : null;
    const safeStartDate = parsedStartDate && !isNaN(parsedStartDate.getTime()) ? parsedStartDate : null;
    let safeEndDate = parsedEndDate && !isNaN(parsedEndDate.getTime()) ? parsedEndDate : null;

    if (safeStartDate && safeEndDate && safeEndDate.getTime() < safeStartDate.getTime()) {
      safeEndDate = new Date(safeStartDate);
    }

    // Build update object with only provided fields
    const updateData: any = {
      updatedAt: new Date()
    };
    
    console.log('[PUT /:id] received body - location:', location, '| locations:', locations, '| locationsArray:', locationsArray, '| multipleLocations:', multipleLocations);
    
    if (location !== undefined) updateData.location = location;
    if (locationsArray !== undefined) updateData.locations = locationsArray;
    if (multipleLocations !== undefined) updateData.multipleLocations = multipleLocations;
    if (startDate !== undefined && safeStartDate) updateData.startDate = safeStartDate;
    if (startTime !== undefined) updateData.startTime = startTime;
    if (endDate !== undefined && safeEndDate) updateData.endDate = safeEndDate;
    if (endTime !== undefined) updateData.endTime = endTime;
    if (dateTimeSlots !== undefined) {
      updateData.dateTimeSlots = dateTimeSlots;
    }
    if (departmentRequirements !== undefined) updateData.departmentRequirements = departmentRequirements;

    const shouldResetToSubmitted = isReschedule && (event.status || '').toString().toLowerCase() === 'approved';

    // If an APPROVED event is rescheduled, reset status to submitted and reset tagged requirements confirmations
    if (shouldResetToSubmitted) {
      updateData.status = 'submitted';
      updateData.submittedAt = new Date();

      const baseReqs = (departmentRequirements !== undefined ? departmentRequirements : (event as any).departmentRequirements) || {};
      const nextReqs: Record<string, any[]> = {};
      Object.keys(baseReqs).forEach((dept) => {
        const arr = Array.isArray(baseReqs[dept]) ? baseReqs[dept] : [];
        nextReqs[dept] = arr.map((r: any) => {
          if (!r || typeof r !== 'object') return r;
          const status = (r.status || '').toString().toLowerCase();
          if (!status || status === 'pending') return r;
          return {
            ...r,
            status: 'pending',
            lastUpdated: new Date().toISOString()
          };
        });
      });
      updateData.departmentRequirements = nextReqs;
    }

    // Update the event
    const updatedEvent = await Event.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );

    // Notify admins in real-time when an approved event is rescheduled (status reset to submitted)
    if (updatedEvent && shouldResetToSubmitted) {
      try {
        const io = req.app.get('io');

        const tz = 'Asia/Manila';

        const toDateOnly = (d: any): string | null => {
          if (!d) return null;
          if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
          const asDate = d instanceof Date ? d : new Date(d);
          if (isNaN(asDate.getTime())) return null;
          return asDate.toISOString().split('T')[0];
        };

        const formatDateTime = (dateValue: any, time: string) => {
          const dateOnly = toDateOnly(dateValue);
          if (!dateOnly) return '';
          const date = new Date(`${dateOnly}T00:00:00`);
          const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz });

          const [hoursStr, minutesStr] = String(time || '').split(':');
          const hourRaw = parseInt(hoursStr);
          const minutes = minutesStr || '00';
          if (isNaN(hourRaw)) return dateStr;

          const ampm = hourRaw >= 12 ? 'PM' : 'AM';
          const displayHour = hourRaw % 12 || 12;
          return `${dateStr} ${displayHour}:${minutes} ${ampm}`;
        };

        const oldStartFormatted = event.startDate ? formatDateTime(event.startDate, event.startTime) : '';
        const oldEndFormatted = event.endDate ? formatDateTime(event.endDate, event.endTime) : '';
        const newStartFormatted = updatedEvent.startDate ? formatDateTime(updatedEvent.startDate, updatedEvent.startTime) : '';
        const newEndFormatted = updatedEvent.endDate ? formatDateTime(updatedEvent.endDate, updatedEvent.endTime) : '';
        const oldSchedule = oldStartFormatted && oldEndFormatted ? `${oldStartFormatted} - ${oldEndFormatted}` : '';
        const newSchedule = newStartFormatted && newEndFormatted ? `${newStartFormatted} - ${newEndFormatted}` : '';

        const title = 'Event Rescheduled';
        const message = `"${event.eventTitle}" was rescheduled by ${event.requestorDepartment}. Please review the updated schedule.`;

        const admins = await User.find({
          role: { $in: [/^Admin$/i, /^superadmin$/i] },
          $or: [{ status: 'active' }, { status: { $exists: false } }]
        }).select('_id role status');

        console.log('📣 [RESCHEDULE NOTIF] shouldResetToSubmitted:', shouldResetToSubmitted);
        console.log('📣 [RESCHEDULE NOTIF] eventId:', String(updatedEvent._id));
        console.log('📣 [RESCHEDULE NOTIF] admins found:', admins.length);

        if (admins.length > 0) {
          const notificationId = `rescheduled-${String(updatedEvent._id)}-${Date.now()}`;

          const notifDocs = admins.map((a: any) => ({
            id: `${notificationId}-${String(a._id)}`,
            title,
            message,
            type: 'status',
            category: 'status',
            eventId: String(updatedEvent._id),
            eventDate: updatedEvent.startDate ? updatedEvent.startDate.toISOString() : undefined,
            userId: String(a._id)
          }));

          await Notification.insertMany(notifDocs, { ordered: false });

          if (io) {
            admins.forEach((a: any) => {
              io.to(`user-${String(a._id)}`).emit('new-notification', {
                eventId: String(updatedEvent._id),
                notificationType: 'event-rescheduled',
                title,
                message,
                eventTitle: event.eventTitle,
                requestorDepartment: event.requestorDepartment,
                oldSchedule,
                newSchedule,
                timestamp: new Date()
              });
            });
          }
        }
      } catch (notifyError) {
        console.error('❌ [RESCHEDULE NOTIF] failed to emit:', notifyError);
        // Don't fail the request if notification fails
      }
    }
    
    // 📍 AUTO-CREATE LOCATION AVAILABILITY FOR CUSTOM LOCATIONS (on update)
    if (location !== undefined && updatedEvent) {
      const predefinedLocations = [
        'Atrium', 'AVR', 'Canteen', 'Covered Court', 'Function Hall',
        'Gymnasium', 'Lobby', 'Open Court', 'Oval', 'Parking Area',
        'Quadrangle', 'Rooftop'
      ];
      
      if (!predefinedLocations.includes(location)) {
        try {
          const eventDate = new Date(updatedEvent.startDate).toISOString().split('T')[0];
          const userDepartment = (req as any).user.department || 'Unknown';
          
          // Check if availability already exists for this location and date
          const existingAvailability = await LocationAvailability.findOne({
            date: eventDate,
            locationName: location
          });
          
          if (!existingAvailability) {
            await LocationAvailability.create({
              date: eventDate,
              locationName: location,
              capacity: 1, // Minimum capacity (N/A)
              description: 'Auto-created from event request',
              status: 'available',
              setBy: userId,
              departmentName: userDepartment
            });
          }
        } catch (locationError) {
          // Don't fail the event update if location availability fails
        }
      }
    }
    
    // Create activity log if this is a reschedule
    if (isReschedule && updatedEvent) {
      try {
        const user = (req as any).user;
        
        // Format dates nicely (e.g., "Oct 23, 2025 8:00 AM")
        const formatDateTime = (date: Date, time: string) => {
          const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          const [hours, minutes] = time.split(':');
          const hour = parseInt(hours);
          const ampm = hour >= 12 ? 'PM' : 'AM';
          const displayHour = hour % 12 || 12;
          return `${dateStr} ${displayHour}:${minutes} ${ampm}`;
        };
        
        const oldStartFormatted = formatDateTime(event.startDate!, event.startTime);
        const oldEndFormatted = formatDateTime(event.endDate!, event.endTime);
        const newStartFormatted = formatDateTime(updatedEvent.startDate!, updatedEvent.startTime);
        const newEndFormatted = formatDateTime(updatedEvent.endDate!, updatedEvent.endTime);
        
        const oldSchedule = `${oldStartFormatted} - ${oldEndFormatted}`;
        const newSchedule = `${newStartFormatted} - ${newEndFormatted}`;
        
        // Determine what changed
        const locationChanged = location !== undefined && location !== event.location;
        const dateTimeChanged = (
          (startDate !== undefined && startDate !== event.startDate?.toISOString().split('T')[0]) ||
          (startTime !== undefined && startTime !== event.startTime) ||
          (endDate !== undefined && endDate !== event.endDate?.toISOString().split('T')[0]) ||
          (endTime !== undefined && endTime !== event.endTime)
        );
        
        let description = '';
        if (locationChanged && dateTimeChanged) {
          description = `Rescheduled event "${event.eventTitle}" from ${oldSchedule} at ${event.location} to ${newSchedule} at ${updatedEvent.location}`;
        } else if (locationChanged) {
          description = `Changed location for event "${event.eventTitle}" from ${event.location} to ${updatedEvent.location}`;
        } else {
          description = `Rescheduled event "${event.eventTitle}" from ${oldSchedule} to ${newSchedule}`;
        }
        
        await UserActivityLog.create({
          userId: user._id,
          username: event.requestor, // Use event's requestor name, not logged-in user
          email: user.email,
          department: event.requestorDepartment, // Use event's requestor department
          action: 'reschedule_event',
          description: description,
          eventId: event._id,
          eventTitle: event.eventTitle,
          details: {
            oldStartDate: event.startDate,
            oldStartTime: event.startTime,
            oldEndDate: event.endDate,
            oldEndTime: event.endTime,
            newStartDate: updatedEvent.startDate,
            newStartTime: updatedEvent.startTime,
            newEndDate: updatedEvent.endDate,
            newEndTime: updatedEvent.endTime,
            oldLocation: event.location,
            newLocation: updatedEvent.location
          },
          timestamp: new Date()
        });
      } catch (logError) {
        // Don't fail the request if logging fails
      }
    }

    res.status(200).json({
      success: true,
      message: 'Event updated successfully',
      event: updatedEvent
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update event',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// PUT /api/events/:eventId/mark-replies-read - Mark all unread replies as read
router.put('/:eventId/mark-replies-read', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { eventId } = req.params;
    const user = (req as any).user;

    // Find the event
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Check if user is the event requestor
    const isRequestor = user.id && event.createdBy && user.id.toString() === event.createdBy.toString();
    if (!isRequestor) {
      return res.status(403).json({
        success: false,
        message: 'Only the event requestor can mark replies as read'
      });
    }

    // Mark all unread replies as read for all requirements
    let repliesMarked = 0;
    for (const [, requirements] of Object.entries(event.departmentRequirements) as [string, any[]][]) {
      for (const requirement of requirements) {
        if (Array.isArray(requirement.replies)) {
          for (const reply of requirement.replies) {
            if (!reply.isRead) {
              reply.isRead = true;
              repliesMarked++;
            }
          }
        }
      }
    }

    // Mark the departmentRequirements field as modified for Mongoose
    event.markModified('departmentRequirements');
    await event.save();

    res.status(200).json({
      success: true,
      message: `Marked ${repliesMarked} replies as read`,
      data: event
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to mark replies as read',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/events/govfile/:filename - Serve government files
router.get('/govfile/:filename', (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    const { download } = req.query;
    const downloadFlag = Array.isArray(download) ? download[0] : download;
    const filePath = path.join(process.cwd(), 'uploads', 'events', String(filename));
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'Government file not found',
        requestedPath: filePath
      });
    }
    
    // If download=true, force download with Content-Disposition header
    if (downloadFlag === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="${String(filename)}"`);
    }
    
    // Serve the file
    res.sendFile(filePath);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to serve government file',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// DELETE /api/events/:eventId/govfile/:fileKey/:filename - Delete a government file (brieferTemplate/programme/availableForDL)
router.delete('/:eventId/govfile/:fileKey/:filename', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { eventId, fileKey, filename } = req.params;
    const userId = (req as any).user._id;
    const userRoleRaw = (req as any).user.role;
    const userRole = (userRoleRaw || '').toString().toLowerCase();

    const allowedKeys = new Set(['brieferTemplate', 'programme', 'availableForDL']);
    if (!allowedKeys.has(String(fileKey))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid government file type'
      });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Check if user owns the event or is admin/superadmin
    if (event.createdBy.toString() !== userId.toString() && userRole !== 'admin' && userRole !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You can only edit your own events.'
      });
    }

    const filenameStr = String(filename);
    const key = String(fileKey) as 'brieferTemplate' | 'programme' | 'availableForDL';
    const currentGov = (event as any).govFiles?.[key];

    if (!currentGov || currentGov.filename !== filenameStr) {
      return res.status(404).json({
        success: false,
        message: 'Government file not found on this event'
      });
    }

    // Remove from DB
    (event as any).govFiles = (event as any).govFiles || {};
    delete (event as any).govFiles[key];
    event.markModified('govFiles');
    await event.save();

    // Best-effort delete from disk
    const filePath = path.join(process.cwd(), 'uploads', 'events', filenameStr);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Don't fail request if disk cleanup fails
    }

    return res.status(200).json({
      success: true,
      message: 'Government file deleted successfully',
      data: event
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to delete government file',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;