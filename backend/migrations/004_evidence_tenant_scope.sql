-- 004: scope evidence files per tenant.
--
-- evidence_files was keyed on the sha256 alone, with no tenant column, and
-- GET /api/evidence/:sha256 only required authentication. With MULTI_TENANT
-- enabled that let any authenticated principal of one tenant download another
-- tenant's evidence if they knew its hash, and — because storage is
-- content-addressed and was deduplicated globally — the stored filename and
-- uploader were whoever uploaded the bytes first, across the tenant boundary.
--
-- The fix keeps one copy of the bytes on disk (the hash in the event is the
-- proof; the blob is just bytes) and makes the metadata row per tenant, so
-- ownership, filename and uploader are tenant-local and the download can be
-- scoped. Anything referencing a file must therefore count rows, not files,
-- before deleting a blob.

CREATE TABLE IF NOT EXISTS evidence_files_scoped (
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  size BIGINT NOT NULL,
  content_type TEXT,
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sha256)
);

-- Files a tenant demonstrably owns: some event of theirs references the hash.
-- events.evidence is a JSONB array of { filename, sha256, size } objects, and
-- events are already tenant-scoped, so the ownership is recorded there. A file
-- referenced by two tenants legitimately becomes one row each.
INSERT INTO evidence_files_scoped (tenant_id, sha256, filename, size, content_type, uploaded_by, uploaded_at)
SELECT DISTINCT e.tenant_id, f.sha256, f.filename, f.size, f.content_type, f.uploaded_by, f.uploaded_at
FROM evidence_files f
JOIN events e ON EXISTS (
  SELECT 1
  FROM jsonb_array_elements(COALESCE(e.evidence, '[]'::jsonb)) AS item
  WHERE item->>'sha256' = f.sha256
)
ON CONFLICT DO NOTHING;

-- Uploaded but never attached to an event, so the database cannot prove who
-- owns them. On a single-tenant install there is exactly one answer and no
-- ambiguity. On a multi-tenant install there is no honest answer, so they are
-- parked rather than guessed: this is evidence data, and assigning it to the
-- wrong tenant would be worse than leaving it unreachable until a human looks.
CREATE TABLE IF NOT EXISTS evidence_files_unclaimed (
  sha256 TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  size BIGINT NOT NULL,
  content_type TEXT,
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  parked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE
  tenant_count INT;
  sole_tenant UUID;
  parked INT;
BEGIN
  -- No min(id): there is no aggregate for uuid, and that would fail here even
  -- on an install with no tenants at all.
  SELECT count(*) INTO tenant_count FROM tenants;

  IF tenant_count = 1 THEN
    SELECT id INTO sole_tenant FROM tenants;

    INSERT INTO evidence_files_scoped (tenant_id, sha256, filename, size, content_type, uploaded_by, uploaded_at)
    SELECT sole_tenant, f.sha256, f.filename, f.size, f.content_type, f.uploaded_by, f.uploaded_at
    FROM evidence_files f
    WHERE NOT EXISTS (SELECT 1 FROM evidence_files_scoped s WHERE s.sha256 = f.sha256)
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO evidence_files_unclaimed (sha256, filename, size, content_type, uploaded_by, uploaded_at)
    SELECT f.sha256, f.filename, f.size, f.content_type, f.uploaded_by, f.uploaded_at
    FROM evidence_files f
    WHERE NOT EXISTS (SELECT 1 FROM evidence_files_scoped s WHERE s.sha256 = f.sha256)
    ON CONFLICT (sha256) DO NOTHING;

    GET DIAGNOSTICS parked = ROW_COUNT;
    IF parked > 0 THEN
      RAISE WARNING 'evidence: % unreferenced file(s) could not be attributed to a tenant and were parked in evidence_files_unclaimed; attribute them manually before they can be downloaded', parked;
    END IF;
  END IF;
END $$;

DROP TABLE evidence_files;
ALTER TABLE evidence_files_scoped RENAME TO evidence_files;
