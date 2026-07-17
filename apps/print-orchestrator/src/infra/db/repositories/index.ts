import type { DatabaseSync } from "node:sqlite";

import type { PrintQueueStore, Repositories } from "../../../domain/print/repositories";
import { SqliteAppMetaRepository } from "./appMetaRepository";
import { SqliteArtifactAnalysisRepository } from "./artifactAnalysisRepository";
import { SqliteArtifactRepository } from "./artifactRepository";
import { SqliteAssignmentRepository } from "./assignmentRepository";
import { SqliteAuditEventRepository } from "./auditEventRepository";
import { SqliteBedCycleRepository } from "./bedCycleRepository";
import { SqliteDispatchAttemptRepository } from "./dispatchAttemptRepository";
import { SqliteMaterialOverrideRepository } from "./materialOverrideRepository";
import { SqlitePlanRepository } from "./planRepository";
import { SqlitePrintRunRepository } from "./printRunRepository";
import { SqlitePrintTaskRepository } from "./printTaskRepository";
import { SqliteProfileRevisionRepository } from "./profileRevisionRepository";
import { SqliteProfileSetRepository } from "./profileSetRepository";
import { SqliteQueueEntryRepository } from "./queueEntryRepository";
import { SqliteSliceVariantRepository } from "./sliceVariantRepository";

/**
 * The SQLite adapter for the {@link PrintQueueStore} port: it owns the
 * connection, wires up every repository against it, and implements the
 * transaction runner. This is the composition seam — the service depends on the
 * port, this class is the only place that knows the repositories are SQLite.
 */
export class SqlitePrintQueueStore implements PrintQueueStore {
  readonly repositories: Repositories;
  private transactionDepth = 0;

  constructor(private readonly db: DatabaseSync) {
    this.repositories = {
      artifacts: new SqliteArtifactRepository(db),
      artifactAnalyses: new SqliteArtifactAnalysisRepository(db),
      tasks: new SqlitePrintTaskRepository(db),
      queue: new SqliteQueueEntryRepository(db),
      plans: new SqlitePlanRepository(db),
      assignments: new SqliteAssignmentRepository(db),
      bedCycles: new SqliteBedCycleRepository(db),
      dispatchAttempts: new SqliteDispatchAttemptRepository(db),
      printRuns: new SqlitePrintRunRepository(db),
      materialOverrides: new SqliteMaterialOverrideRepository(db),
      audit: new SqliteAuditEventRepository(db),
      meta: new SqliteAppMetaRepository(db),
      profileRevisions: new SqliteProfileRevisionRepository(db),
      profileSets: new SqliteProfileSetRepository(db),
      sliceVariants: new SqliteSliceVariantRepository(db)
    };
  }

  /**
   * Runs `fn` in a single transaction. Nested calls join the outer transaction
   * (no nested BEGIN — SQLite has none without SAVEPOINT), so a service method
   * that itself wraps a transaction can still be called from within one and the
   * outermost frame owns the commit/rollback.
   */
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) {
      return fn();
    }
    this.db.exec("BEGIN");
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  close(): void {
    this.db.close();
  }
}
