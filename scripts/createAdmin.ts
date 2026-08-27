import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import User from '../models/User.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env
try {
  dotenv.config({ path: path.join(__dirname, '../.env') });
} catch (e) {
  // Use environment variables directly
}

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function createAdmin() {
  if (!MONGODB_URI) {
    console.error('❌ Error: MONGODB_URI environment variable is not set.');
    process.exit(1);
  }

  // Parse CLI args or use defaults
  const args = process.argv.slice(2);
  const username = args[0] || process.env.ADMIN_USERNAME || 'superadmin';
  const email = args[1] || process.env.ADMIN_EMAIL || 'admin@bataan.gov.ph';
  const password = args[2] || process.env.ADMIN_PASSWORD || 'Admin@2025!';
  const department = args[3] || process.env.ADMIN_DEPT || 'PGO';
  const role = (args[4] || process.env.ADMIN_ROLE || 'superadmin') as 'Admin' | 'superadmin';

  console.log('🔄 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB.');

  const existingUser = await User.findOne({
    $or: [{ username }, { email }]
  });

  if (existingUser) {
    console.log(`⚠️ User with username "${username}" or email "${email}" already exists.`);
    console.log('🔄 Updating password and setting role to Admin/active...');
    existingUser.password = password;
    existingUser.role = role;
    existingUser.status = 'active';
    existingUser.department = department;
    await existingUser.save();
    console.log(`✅ Successfully updated user "${username}" to ${role}!`);
  } else {
    const newUser = new User({
      username,
      email,
      password,
      department,
      role,
      status: 'active'
    });
    await newUser.save();
    console.log(`✅ Successfully created new ${role} user: "${username}"!`);
  }

  console.log('\n📋 Account Credentials:');
  console.log(`   Username: ${username}`);
  console.log(`   Email:    ${email}`);
  console.log(`   Password: ${password}`);
  console.log(`   Role:     ${role}`);
  console.log(`   Dept:     ${department}\n`);

  await mongoose.disconnect();
  process.exit(0);
}

createAdmin().catch((err) => {
  console.error('❌ Error creating admin:', err);
  process.exit(1);
});
