-- SIMPLE VECTOR DIMENSION MIGRATION SCRIPT
-- Direct approach for pgvector dimension change

-- Check if vector extension is installed
SELECT extname FROM pg_extension WHERE extname = 'vector';

-- Check current dimensions
SELECT 
  CASE 
    WHEN LENGTH(CAST(embedding AS text)) > 1000 THEN 1536
    ELSE 384
  END as approximate_dimension,
  COUNT(*) 
FROM memories 
WHERE embedding IS NOT NULL
GROUP BY 1;

-- For PostgreSQL 14+, directly alter the column type
ALTER TABLE memories
  ALTER COLUMN embedding TYPE vector(1536);

-- Final verification
SELECT 
  CASE 
    WHEN LENGTH(CAST(embedding AS text)) > 1000 THEN 1536
    ELSE 384
  END as dimension,
  COUNT(*) 
FROM memories 
WHERE embedding IS NOT NULL
GROUP BY 1; 