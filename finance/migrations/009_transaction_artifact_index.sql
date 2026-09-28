-- Rows are found and deleted by the document they came from, to undo an import.
create index if not exists transactions_artifact_idx on transactions (artifact_id)
  where artifact_id is not null;
