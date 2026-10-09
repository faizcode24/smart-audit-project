import mongoose from 'mongoose';
import { config } from './config.js';
import { AuditRepository } from './repositories/AuditRepository.js';
import { AuditEntry } from './models/AuditEntry.js';

const tenantId = new mongoose.Types.ObjectId(config.defaultTenantId);

const samples = [
  { evidenceId: 'EVID-902188', entityName: 'Global Procurement Services', controlId: 'CTRL-FIN-302', actorUserId: 'user_7731', monetaryImpact: 85000,
    description: 'Manual approval override executed for vendor invoice payables exceeding $50k threshold' },
  { evidenceId: 'EVID-902201', entityName: 'Treasury Operations', controlId: 'CTRL-TRS-114', actorUserId: 'user_1042', monetaryImpact: 275000,
    description: 'Emergency manual wire transfer released outside standard approval window to new beneficiary' },
  { evidenceId: 'EVID-902219', entityName: 'Accounts Payable EMEA', controlId: 'CTRL-FIN-101', actorUserId: 'user_2210', monetaryImpact: 4200,
    description: 'Routine monthly invoice approval for office supplies vendor' },
  { evidenceId: 'EVID-902234', entityName: 'Regional Sales Operations', controlId: 'CTRL-FIN-302', actorUserId: 'user_5120', monetaryImpact: 52000,
    description: 'Duplicate vendor invoice payment split into two transactions just under the approval limit' },
  { evidenceId: 'EVID-902250', entityName: 'Payroll Services', controlId: 'CTRL-GL-210', actorUserId: 'user_3308', monetaryImpact: 18500,
    description: 'Manual adjustment journal entry for payroll accrual correction' },
];

async function seed() {
  await mongoose.connect(config.mongoUri);
  const repo = new AuditRepository();
  const removed = await AuditEntry.deleteMany({ tenantId });
  for (const [i, s] of samples.entries()) {
    // staggered timestamps so the stream has a natural order
    await repo.create({ ...s, tenantId, timestamp: new Date(Date.now() - (samples.length - i) * 3600_000) });
  }
  console.log(`Seeded ${samples.length} audit entries as PENDING (replaced ${removed.deletedCount}).`);
  console.log('Start the app (npm run dev) and the AI worker will enrich them.');
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
