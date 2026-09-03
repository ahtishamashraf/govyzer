#!/usr/bin/env node
import process from 'node:process';
import { getDb, destroyDb } from '../src/client.js';
import { migrateLatest, migrateRollback, migrationStatus, runSeeds, resetDatabase } from '../src/migrator.js';

const command = process.argv[2];

async function main() {
  const db = getDb();
  switch (command) {
    case 'migrate': {
      const { batch, applied } = await migrateLatest(db);
      console.log(applied.length ? `Batch ${batch}: applied ${applied.length} migration(s)` : 'Already up to date');
      applied.forEach((name) => console.log(`  + ${name}`));
      break;
    }
    case 'rollback': {
      const all = process.argv.includes('--all');
      const { batch, reverted } = await migrateRollback(db, all);
      console.log(`Batch ${batch}: reverted ${reverted.length} migration(s)`);
      break;
    }
    case 'status': {
      const status = await migrationStatus(db);
      console.log(`Completed: ${status.completed.length}`);
      status.pending.forEach((name) => console.log(`  pending: ${name}`));
      break;
    }
    case 'seed': {
      const files = await runSeeds(db);
      console.log(`Ran ${files.length} seed file(s)`);
      break;
    }
    case 'reset': {
      await resetDatabase(db);
      console.log('Database reset and migrated');
      break;
    }
    default:
      console.error('Usage: db.js <migrate|rollback|status|seed|reset>');
      process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => destroyDb());
