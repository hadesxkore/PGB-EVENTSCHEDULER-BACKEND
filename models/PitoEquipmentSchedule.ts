import mongoose, { Document, Schema } from 'mongoose';

export interface IPitoEquipmentSchedule extends Document {
  equipmentId: string;
  equipmentName: string;
  startDate: string;   // YYYY-MM-DD
  endDate: string;     // YYYY-MM-DD
  reason: string;
  setBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PitoEquipmentScheduleSchema = new Schema<IPitoEquipmentSchedule>(
  {
    equipmentId:   { type: String, required: true },
    equipmentName: { type: String, required: true },
    startDate:     { type: String, required: true },
    endDate:       { type: String, required: true },
    reason:        { type: String, default: '' },
    setBy:         { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

PitoEquipmentScheduleSchema.index({ equipmentId: 1, startDate: 1, endDate: 1 });

export default mongoose.model<IPitoEquipmentSchedule>(
  'PitoEquipmentSchedule',
  PitoEquipmentScheduleSchema
);
