import cron from 'node-cron';
import { cleanupPastLocationAvailabilities } from '../routes/locationAvailability.js';
import { cleanupPastResourceAvailabilities } from '../routes/resourceAvailability.js';
import Event from '../models/Event.js';

// Auto-complete events that have ended
const autoCompleteEvents = async (io: any) => {
  try {
    const now = new Date();

    // Find events that should be completed (ended but not yet marked as completed/cancelled)
    const events = await Event.find({
      status: { $nin: ['completed', 'cancelled'] }
    });

    let completedCount = 0;

    for (const event of events) {
      try {
        // Parse end date and time to create a complete datetime
        // endDate is a Date object, endTime is a string like "14:00"
        const endDate = new Date(event.endDate);
        const [hours, minutes] = event.endTime.split(':').map(Number);

        // Create a new date with the time set
        const eventEndDateTime = new Date(endDate);
        eventEndDateTime.setHours(hours, minutes, 0, 0);

        // Check if event has ended
        if (eventEndDateTime <= now) {
          // Update status to completed
          event.status = 'completed';
          await event.save();

          completedCount++;

          // Emit WebSocket event to notify all clients
          if (io) {
            io.emit('event-status-updated', {
              eventId: event._id,
              eventTitle: event.eventTitle,
              status: 'completed',
              autoCompleted: true,
              completedAt: now.toISOString()
            });

            // Also emit general event update
            io.emit('event-updated', {
              eventId: event._id,
              eventTitle: event.eventTitle,
              action: 'auto-completed'
            });
          }
        }
      } catch (error) {
        // Error auto-completing event
      }
    }

    return { success: true, completedCount };
  } catch (error) {
    return { success: false, completedCount: 0, error };
  }
};

// Auto-approve submitted events that start within the next 10 days
const autoApproveUrgentEvents = async (io: any) => {
  try {
    const nowManila = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));

    // Build a cutoff: midnight of (today + 10 days) in Manila time
    const cutoff = new Date(nowManila);
    cutoff.setDate(cutoff.getDate() + 10);
    cutoff.setHours(23, 59, 59, 999);

    // Find all submitted events whose startDate is on or before the cutoff
    // Exclude BAC location events — BAC has sole authority to approve/reject those
    const urgentEvents = await Event.find({
      status: 'submitted',
      startDate: { $lte: cutoff },
      location: { $ne: '5th Flr. Training Room 1 (BAC)' }
    });

    let approvedCount = 0;

    for (const event of urgentEvents) {
      try {
        const startDateManila = new Date(
          new Date(event.startDate).toLocaleString('en-US', { timeZone: 'Asia/Manila' })
        );

        // Normalize both to date-only (midnight) for comparison
        const todayMidnight = new Date(nowManila);
        todayMidnight.setHours(0, 0, 0, 0);

        const eventMidnight = new Date(startDateManila);
        eventMidnight.setHours(0, 0, 0, 0);

        const diffDays = Math.floor(
          (eventMidnight.getTime() - todayMidnight.getTime()) / (1000 * 60 * 60 * 24)
        );

        // Auto-approve if within the next 10 days (0-10 days from now)
        if (diffDays >= 0 && diffDays <= 10) {
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

          (event as any).status = 'approved';
          (event as any).approvedAt = new Date();
          (event as any).autoApproved = true;
          (event as any).markModified('departmentRequirements');
          await event.save();

          approvedCount++;

          console.log(
            `✅ Auto-approved event: "${event.eventTitle}" (starts in ${diffDays} day(s))`
          );

          if (io) {
            io.emit('event-status-updated', {
              eventId: event._id,
              eventTitle: event.eventTitle,
              status: 'approved',
              autoApproved: true,
              approvedAt: new Date().toISOString()
            });

            io.emit('event-updated', {
              eventId: event._id,
              eventTitle: event.eventTitle,
              action: 'auto-approved'
            });

            // Notify tagged departments
            if (event.taggedDepartments && event.taggedDepartments.length > 0) {
              io.emit('new-notification', {
                type: 'event_approved',
                eventId: event._id,
                eventTitle: event.eventTitle,
                status: 'approved',
                message: `Event "${event.eventTitle}" has been approved`,
                timestamp: Date.now()
              });

              event.taggedDepartments.forEach((dept: string) => {
                io.emit('status-update', {
                  eventId: event._id,
                  eventTitle: event.eventTitle,
                  department: dept,
                  status: 'approved',
                  message: `Event "${event.eventTitle}" has been approved. Requirements are now available for your department.`
                });
              });
            }
          }
        }
      } catch (err) {
        console.error(`❌ Failed to auto-approve event ${event._id}:`, err);
      }
    }

    if (approvedCount > 0) {
      console.log(`🤖 Auto-approval: approved ${approvedCount} urgent event(s)`);
    }

    return { success: true, approvedCount };
  } catch (error) {
    console.error('❌ Auto-approval scheduler error:', error);
    return { success: false, approvedCount: 0, error };
  }
};

// Schedule cleanup to run daily at midnight (00:00)
export const startScheduler = (io?: any) => {
  console.log('🕐 Starting automated scheduler...');

  // Run cleanup daily at midnight
  cron.schedule('0 0 * * *', async () => {
    const scheduleTime = new Date().toLocaleString('en-PH', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const locationResult = await cleanupPastLocationAvailabilities();
    const resourceResult = await cleanupPastResourceAvailabilities();
  }, {
    scheduled: true,
    timezone: "Asia/Manila"
  });

  // Run cleanup every 12 hours (at 12:00 PM and 12:00 AM)
  cron.schedule('0 */12 * * *', async () => {
    const cleanupTime = new Date().toLocaleString('en-PH', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const locationResult = await cleanupPastLocationAvailabilities();
    const resourceResult = await cleanupPastResourceAvailabilities();
  }, {
    scheduled: true,
    timezone: "Asia/Manila"
  });

  // Auto-complete events every minute
  cron.schedule('* * * * *', async () => {
    await autoCompleteEvents(io);
  }, {
    scheduled: true,
    timezone: "Asia/Manila"
  });

  // Auto-approve urgent submitted events every minute
  cron.schedule('* * * * *', async () => {
    await autoApproveUrgentEvents(io);
  }, {
    scheduled: true,
    timezone: "Asia/Manila"
  });

  console.log('✅ Scheduler started successfully');
  console.log('📅 Automated tasks: cleanup, event completion & auto-approval');
};

// Function to run cleanup immediately (for testing)
export const runCleanupNow = async () => {
  const locationResult = await cleanupPastLocationAvailabilities();
  const resourceResult = await cleanupPastResourceAvailabilities();

  return {
    success: locationResult.success && resourceResult.success,
    locationAvailabilities: locationResult,
    resourceAvailabilities: resourceResult,
    totalDeleted: (locationResult.deletedCount || 0) + (resourceResult.deletedCount || 0)
  };
};
