import express, { Request, Response } from 'express';
import mongoose from 'mongoose';
import ResourceAvailability from '../models/ResourceAvailability.js';
import PitoEquipmentSchedule from '../models/PitoEquipmentSchedule.js';
import Department from '../models/Department.js';
import Event from '../models/Event.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Get department requirements for calendar
router.get('/department/:departmentId/requirements', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { departmentId } = req.params;

    const department = await Department.findById(departmentId);
    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    res.json({
      departmentId: department._id,
      departmentName: department.name,
      requirements: department.requirements
    });
  } catch (error) {
    console.error('Error fetching department requirements:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get availability for a specific date range
router.get('/department/:departmentId/availability', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { departmentId } = req.params;
    const { startDate, endDate } = req.query;

    const query: any = { departmentId };

    if (startDate && endDate) {
      query.date = {
        $gte: startDate,
        $lte: endDate
      };
    } else if (startDate) {
      query.date = startDate;
    }

    const availability = await ResourceAvailability.find(query)
      .populate('setBy', 'name email')
      .sort({ date: 1, requirementText: 1 });

    res.json(availability);
  } catch (error) {
    console.error('Error fetching availability:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Set availability for a specific requirement on a date
router.post('/availability', authenticateToken, async (req: Request, res: Response) => {
  try {
    const {
      departmentId,
      departmentName,
      requirementId,
      requirementText,
      date,
      isAvailable,
      notes,
      quantity,
      maxCapacity
    } = req.body;

    // Validate required fields
    if (!departmentId || !requirementId || !requirementText || !date) {
      return res.status(400).json({
        message: 'Department ID, requirement ID, requirement text, and date are required'
      });
    }

    // Check if availability already exists for this requirement on this date
    let availability = await ResourceAvailability.findOne({
      departmentId,
      requirementId,
      date
    });

    if (availability) {
      // Update existing availability
      availability.isAvailable = isAvailable !== undefined ? isAvailable : availability.isAvailable;
      availability.notes = notes !== undefined ? notes : availability.notes;
      availability.quantity = quantity !== undefined ? quantity : availability.quantity;
      availability.maxCapacity = maxCapacity !== undefined ? maxCapacity : availability.maxCapacity;
      availability.setBy = req.user!._id as mongoose.Types.ObjectId;
      availability.updatedAt = new Date();

      await availability.save();
    } else {
      // Create new availability record
      availability = new ResourceAvailability({
        departmentId,
        departmentName,
        requirementId,
        requirementText,
        date,
        isAvailable: isAvailable !== undefined ? isAvailable : true,
        notes: notes || '',
        quantity: quantity || 1,
        maxCapacity: maxCapacity || 1,
        setBy: req.user!._id as mongoose.Types.ObjectId
      });

      await availability.save();
    }

    // Populate the setBy field before sending response
    await availability.populate('setBy', 'name email');

    res.json({
      message: 'Availability updated successfully',
      availability
    });
  } catch (error) {
    console.error('Error setting availability:', error);

    if ((error as any).code === 11000) {
      return res.status(400).json({
        message: 'Availability already exists for this requirement on this date'
      });
    }

    res.status(500).json({ message: 'Server error' });
  }
});

// Bulk set availability for multiple requirements on a date
router.post('/availability/bulk', authenticateToken, async (req: Request, res: Response) => {
  try {
    const {
      departmentId,
      departmentName,
      date,
      requirements // Array of { requirementId, requirementText, isAvailable, notes, quantity, maxCapacity }
    } = req.body;

    if (!departmentId || !date || !requirements || !Array.isArray(requirements)) {
      return res.status(400).json({
        message: 'Department ID, date, and requirements array are required'
      });
    }

    const results: any[] = [];
    const errors: any[] = [];

    for (const req_item of requirements) {
      try {
        let availability = await ResourceAvailability.findOne({
          departmentId,
          requirementId: req_item.requirementId,
          date
        });

        if (availability) {
          // Update existing
          availability.isAvailable = req_item.isAvailable !== undefined ? req_item.isAvailable : availability.isAvailable;
          availability.notes = req_item.notes !== undefined ? req_item.notes : availability.notes;
          availability.quantity = req_item.quantity !== undefined ? req_item.quantity : availability.quantity;
          availability.maxCapacity = req_item.maxCapacity !== undefined ? req_item.maxCapacity : availability.maxCapacity;
          availability.setBy = req.user!._id as mongoose.Types.ObjectId;
          availability.updatedAt = new Date();

          await availability.save();
        } else {
          // Create new
          availability = new ResourceAvailability({
            departmentId,
            departmentName,
            requirementId: req_item.requirementId,
            requirementText: req_item.requirementText,
            date,
            isAvailable: req_item.isAvailable !== undefined ? req_item.isAvailable : true,
            notes: req_item.notes || '',
            quantity: req_item.quantity || 1,
            maxCapacity: req_item.maxCapacity || 1,
            setBy: req.user!._id as mongoose.Types.ObjectId
          });

          await availability.save();
        }

        await availability.populate('setBy', 'name email');
        results.push(availability);
      } catch (error) {
        errors.push({
          requirementId: req_item.requirementId,
          error: (error as Error).message
        });
      }
    }

    res.json({
      message: 'Bulk availability update completed',
      successful: results.length,
      failed: errors.length,
      results,
      errors
    });
  } catch (error) {
    console.error('Error in bulk availability update:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete availability for a specific requirement on a date
router.delete('/availability/:departmentId/:requirementId/:date', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { departmentId, requirementId, date } = req.params;

    const availability = await ResourceAvailability.findOneAndDelete({
      departmentId,
      requirementId,
      date
    });

    if (!availability) {
      return res.status(404).json({ message: 'Availability record not found' });
    }

    res.json({ message: 'Availability deleted successfully' });
  } catch (error) {
    console.error('Error deleting availability:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete ALL availability data for a department on a specific date
router.delete('/department/:departmentId/date/:date', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { departmentId, date } = req.params;

    console.log(`🗑️ Deleting all availability data for department ${departmentId} on date ${date}`);

    const result = await ResourceAvailability.deleteMany({
      departmentId,
      date
    });

    console.log(`✅ Deleted ${result.deletedCount} availability records for ${date}`);

    res.json({
      message: 'All availability data deleted successfully for the specified date',
      deletedCount: result.deletedCount,
      date: date,
      departmentId: departmentId
    });
  } catch (error) {
    console.error('Error deleting all availability data for date:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Bulk delete availability data for a department across multiple dates (with booking protection)
router.delete('/department/:departmentId/bulk-dates', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { departmentId } = req.params;
    const { dates } = req.body; // Array of date strings

    if (!dates || !Array.isArray(dates)) {
      return res.status(400).json({
        message: 'Dates array is required in request body'
      });
    }

    console.log(`🗑️ Bulk deleting availability data for department ${departmentId} across ${dates.length} dates`);

    // Get department info to check for tagged events
    const department = await Department.findById(departmentId);
    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    let totalDeleted = 0;
    let protectedDates = 0;
    const results: any[] = [];
    const protectedDatesList: string[] = [];

    for (const date of dates) {
      try {
        // Check if there are any active bookings (events) for this department on this date
        const dateObj = new Date(date);
        const nextDateObj = new Date(dateObj);
        nextDateObj.setDate(nextDateObj.getDate() + 1);

        const activeBookings = await Event.find({
          taggedDepartments: department.name,
          status: { $in: ['submitted', 'approved'] }, // Only check active bookings
          $or: [
            // Event starts on this date
            {
              startDate: {
                $gte: dateObj,
                $lt: nextDateObj
              }
            },
            // Event ends on this date
            {
              endDate: {
                $gte: dateObj,
                $lt: nextDateObj
              }
            },
            // Event spans across this date
            {
              startDate: { $lte: dateObj },
              endDate: { $gte: dateObj }
            }
          ]
        });

        if (activeBookings.length > 0) {
          // Protect this date - don't delete availability data
          protectedDates++;
          protectedDatesList.push(date);
          results.push({
            date,
            deletedCount: 0,
            success: false,
            protected: true,
            reason: `Protected: ${activeBookings.length} active booking(s) found`,
            bookings: activeBookings.map(event => ({
              eventTitle: event.eventTitle,
              status: event.status,
              startDate: event.startDate,
              endDate: event.endDate
            }))
          });

          console.log(`🛡️ Protected ${date}: ${activeBookings.length} active booking(s) found`);
        } else {
          // Safe to delete - no active bookings
          const result = await ResourceAvailability.deleteMany({
            departmentId,
            date
          });

          totalDeleted += result.deletedCount;
          results.push({
            date,
            deletedCount: result.deletedCount,
            success: true,
            protected: false
          });

          console.log(`✅ Deleted ${result.deletedCount} records for ${date}`);
        }
      } catch (error) {
        console.error(`❌ Error processing ${date}:`, error);
        results.push({
          date,
          deletedCount: 0,
          success: false,
          protected: false,
          error: (error as Error).message
        });
      }
    }

    console.log(`🎯 Bulk delete completed: ${totalDeleted} records deleted, ${protectedDates} dates protected`);

    res.json({
      message: 'Bulk delete completed with booking protection',
      totalDeleted,
      protectedDates,
      processedDates: dates.length,
      protectedDatesList,
      results
    });
  } catch (error) {
    console.error('Error in bulk delete operation:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all dates with availability for a department
router.get('/department/:departmentId/all-dates', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { departmentId } = req.params;

    // Get all unique dates that have availability records for this department
    const availabilityRecords = await ResourceAvailability.find({
      departmentId,
      isAvailable: true // Only get available dates
    })
      .select('date requirementText quantity maxCapacity notes')
      .sort({ date: 1 });

    // Group by date and aggregate the data
    const dateMap = new Map();

    availabilityRecords.forEach(record => {
      const dateStr = record.date;

      if (!dateMap.has(dateStr)) {
        dateMap.set(dateStr, {
          date: dateStr,
          availableCount: 0,
          resources: []
        });
      }

      const dateEntry = dateMap.get(dateStr);
      dateEntry.availableCount += 1;
      dateEntry.resources.push({
        name: record.requirementText,
        quantity: record.quantity,
        maxCapacity: record.maxCapacity,
        notes: record.notes
      });
    });

    // Convert map to array and sort by date
    const result = Array.from(dateMap.values()).sort((a, b) =>
      new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    console.log(`📅 Found ${result.length} dates with availability for department ${departmentId}`);
    res.json(result);
  } catch (error) {
    console.error('Error fetching all dates with availability:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get availability summary for a department
router.get('/department/:departmentId/summary', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { departmentId } = req.params;
    const { month, year } = req.query;

    let dateFilter: any = {};
    if (month && year) {
      const yearStr = Array.isArray(year) ? year[0] : year;
      const monthStr = Array.isArray(month) ? month[0] : month;
      const startDate = `${String(yearStr)}-${String(monthStr).padStart(2, '0')}-01`;
      const endDate = `${String(yearStr)}-${String(monthStr).padStart(2, '0')}-31`;
      dateFilter = {
        date: {
          $gte: startDate,
          $lte: endDate
        }
      };
    }

    const summary = await ResourceAvailability.aggregate([
      {
        $match: {
          departmentId: new mongoose.Types.ObjectId(String(departmentId)),
          ...dateFilter
        }
      },
      {
        $group: {
          _id: {
            requirementId: '$requirementId',
            requirementText: '$requirementText'
          },
          totalDays: { $sum: 1 },
          availableDays: {
            $sum: { $cond: ['$isAvailable', 1, 0] }
          },
          unavailableDays: {
            $sum: { $cond: ['$isAvailable', 0, 1] }
          }
        }
      },
      {
        $project: {
          requirementId: '$_id.requirementId',
          requirementText: '$_id.requirementText',
          totalDays: 1,
          availableDays: 1,
          unavailableDays: 1,
          availabilityRate: {
            $multiply: [
              { $divide: ['$availableDays', '$totalDays'] },
              100
            ]
          }
        }
      }
    ]);

    res.json(summary);
  } catch (error) {
    console.error('Error fetching availability summary:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Cleanup function to delete past resource availability records
export const cleanupPastResourceAvailabilities = async () => {
  try {
    // Get today's date in YYYY-MM-DD format
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    console.log(`🧹 Starting cleanup of resource availabilities before ${todayStr}`);

    // Delete all resource availability records with dates before today
    const result = await ResourceAvailability.deleteMany({
      date: { $lt: todayStr }
    });

    console.log(`✅ Cleanup completed: Deleted ${result.deletedCount} past resource availability records`);

    return {
      success: true,
      deletedCount: result.deletedCount,
      message: `Deleted ${result.deletedCount} past resource availability records`
    };
  } catch (error) {
    console.error('❌ Error during resource availability cleanup:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      message: 'Failed to cleanup past resource availabilities'
    };
  }
};

// Manual cleanup endpoint (for testing or manual triggers)
router.post('/cleanup-past', authenticateToken, async (req: Request, res: Response) => {
  try {
    const result = await cleanupPastResourceAvailabilities();

    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        deletedCount: result.deletedCount
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.message,
        error: result.error
      });
    }
  } catch (error) {
    console.error('Error in manual resource cleanup endpoint:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to execute resource cleanup',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PITO EQUIPMENT AVAILABILITY – date-range endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/resource-availability/pito/equipment
 * Returns the PITO department's requirement list (from Department model).
 * Any authenticated user can call this (needed by RequestEventPage).
 */
router.get('/pito/equipment', authenticateToken, async (req: Request, res: Response) => {
  try {
    const pitoDoc = await Department.findOne({ name: 'PITO' }).lean();

    // Static PITO equipment list (mirrors the hardcoded list in RequestEventPage)
    const staticEquipment = [
      { id: 'pito-led-wall-operator', name: 'LED Wall with Operator', type: 'service' },
      { id: 'pito-led-wall', name: 'LED Wall', type: 'service' },
      { id: 'pito-projector', name: 'Projector with VGA', type: 'service' },
      { id: 'pito-internet', name: 'Internet Connection', type: 'service' },
      { id: 'pito-tv', name: 'TV', type: 'service' },
      { id: 'pito-hdmi-cable', name: '10-meter HDMI Cable', type: 'service' },
    ];

    if (!pitoDoc) {
      return res.json({ success: true, data: staticEquipment });
    }

    // Merge with any dynamic items stored in Department.requirements
    const deptReqs: any[] = (pitoDoc as any).requirements || [];
    const extraItems = deptReqs
      .filter((r: any) => r.isActive !== false)
      .filter((r: any) => !staticEquipment.some(s => s.name.toLowerCase() === (r.text || '').toLowerCase()))
      .map((r: any) => ({
        id: String(r._id),
        name: r.text,
        type: r.type || 'service',
      }));

    return res.json({ success: true, data: [...staticEquipment, ...extraItems] });
  } catch (error) {
    console.error('Error fetching PITO equipment list:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /api/resource-availability/pito/schedules
 * Returns all PITO unavailability schedules (date ranges).
 * Query params: startDate (YYYY-MM-DD), endDate (YYYY-MM-DD) — optional filters.
 */
router.get('/pito/schedules', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;

    const filter: any = {};
    if (startDate && endDate) {
      // Overlapping ranges: schedule.startDate <= endDate AND schedule.endDate >= startDate
      filter.startDate = { $lte: String(endDate) };
      filter.endDate = { $gte: String(startDate) };
    } else if (startDate) {
      filter.endDate = { $gte: String(startDate) };
    }

    const schedules = await PitoEquipmentSchedule.find(filter)
      .populate('setBy', 'name email')
      .sort({ equipmentName: 1, startDate: 1 })
      .lean();

    // Map to a stable id for the frontend
    const data = schedules.map((s: any) => ({
      id: String(s._id),
      equipmentId: s.equipmentId,
      equipmentName: s.equipmentName,
      startDate: s.startDate,
      endDate: s.endDate,
      reason: s.reason || '',
      setBy: s.setBy,
      createdAt: s.createdAt,
    }));

    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching PITO schedules:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * POST /api/resource-availability/pito/schedules
 * Create an unavailability schedule for a PITO equipment item over a date range.
 * Body: { equipmentId, equipmentName, startDate, endDate, reason }
 * Only PITO department users (or admin/superadmin) can call this.
 */
router.post('/pito/schedules', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const userDept = (user?.department || '').trim().toUpperCase();
    const userRole = (user?.role || '').trim().toLowerCase();

    if (userDept !== 'PITO' && userRole !== 'admin' && userRole !== 'superadmin') {
      return res.status(403).json({ success: false, message: 'Only PITO users can manage equipment availability' });
    }

    const { equipmentId, equipmentName, startDate, endDate, reason } = req.body;

    if (!equipmentId || !equipmentName || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'equipmentId, equipmentName, startDate, and endDate are required',
      });
    }

      if (startDate > endDate) {
        return res.status(400).json({ success: false, message: 'startDate must be before or equal to endDate' });
      }

      const schedule = await PitoEquipmentSchedule.create({
        equipmentId,
        equipmentName,
        startDate,
        endDate,
        reason: reason || '',
        setBy: user._id,
      });

      return res.json({ success: true, message: 'Equipment marked unavailable', data: schedule });
    } catch (error) {
      console.error('Error creating PITO schedule:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

/**
 * DELETE /api/resource-availability/pito/schedules
 * Remove a specific unavailability schedule by its _id.
 * Body: { scheduleId }
 * Only PITO department users (or admin/superadmin) can call this.
 */
router.delete('/pito/schedules', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const userDept = (user?.department || '').trim().toUpperCase();
    const userRole = (user?.role || '').trim().toLowerCase();

    if (userDept !== 'PITO' && userRole !== 'admin' && userRole !== 'superadmin') {
      return res.status(403).json({ success: false, message: 'Only PITO users can manage equipment availability' });
    }

    const { scheduleId } = req.body;

      if (!scheduleId) {
        return res.status(400).json({ success: false, message: 'scheduleId is required' });
      }

      const result = await PitoEquipmentSchedule.findByIdAndDelete(scheduleId);
      if (!result) {
        return res.status(404).json({ success: false, message: 'Schedule not found' });
      }

      return res.json({ success: true, message: 'Unavailability schedule removed' });
    } catch (error) {
      console.error('Error deleting PITO schedule:', error);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

/**
 * POST /api/resource-availability/pito/check
 * Check which PITO equipment items are unavailable for a given date range.
 * Body: { startDate, endDate }
 * Returns: { unavailableNames: string[], unavailableIds: string[] }
 * Any authenticated user can call this (needed by RequestEventPage).
 */
router.post('/pito/check', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.body;
    if (!startDate) {
      return res.status(400).json({ success: false, message: 'startDate is required' });
    }

    const end = endDate || startDate;

    // Find schedules whose range overlaps [startDate, end]
    const schedules = await PitoEquipmentSchedule.find({
      startDate: { $lte: end },
      endDate: { $gte: startDate },
    }).select('equipmentId equipmentName').lean();

    const unavailableNames = [...new Set(schedules.map((s: any) => s.equipmentName))];
    const unavailableIds = [...new Set(schedules.map((s: any) => s.equipmentId))];

    return res.json({ success: true, unavailableNames, unavailableIds });
  } catch (error) {
    console.error('Error checking PITO equipment availability:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;

