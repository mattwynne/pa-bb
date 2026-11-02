// Additive first native stage bookkeeping. Frozen migrations 0..12 stay exact.
export const SEMANTIC_STAGE_MIGRATION=`
CREATE TABLE docs_semantic_stage_events(operation_id TEXT NOT NULL,sequence INTEGER NOT NULL,event TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(operation_id,sequence));
CREATE TRIGGER semantic_stage_event_no_update BEFORE UPDATE ON docs_semantic_stage_events BEGIN SELECT RAISE(ABORT,'Immutable semantic stage event'); END;
CREATE TRIGGER semantic_stage_event_no_delete BEFORE DELETE ON docs_semantic_stage_events BEGIN SELECT RAISE(ABORT,'Retained semantic stage event'); END;
CREATE TABLE docs_semantic_stage_evidence(operation_id TEXT NOT NULL,kind TEXT NOT NULL,bytes INTEGER NOT NULL,data BLOB NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(operation_id,kind));
CREATE TRIGGER semantic_stage_evidence_no_update BEFORE UPDATE ON docs_semantic_stage_evidence BEGIN SELECT RAISE(ABORT,'Immutable semantic stage evidence'); END;
CREATE TRIGGER semantic_stage_evidence_no_delete BEFORE DELETE ON docs_semantic_stage_evidence BEGIN SELECT RAISE(ABORT,'Retained semantic stage evidence'); END;
DROP TRIGGER semantic_execution_ref_no_update;
CREATE TRIGGER semantic_execution_ref_identity_no_update BEFORE UPDATE OF operation_id,snapshot,subject,receipt,digest ON docs_semantic_execution_refs BEGIN SELECT RAISE(ABORT,'Immutable execution evidence identity'); END;
CREATE TRIGGER semantic_execution_credit_no_increase BEFORE UPDATE OF reserved_bytes ON docs_semantic_execution_refs WHEN NEW.reserved_bytes<0 OR NEW.reserved_bytes>OLD.reserved_bytes BEGIN SELECT RAISE(ABORT,'Invalid execution evidence credit'); END;
`;
