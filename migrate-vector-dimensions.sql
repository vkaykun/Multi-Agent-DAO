-- VECTOR DIMENSION MIGRATION SCRIPT
-- Migrates embedding vectors from 384 dimensions to 1536 dimensions
-- IMPORTANT: Take a database backup before running this script!

-- Step 1: Create a backup table
CREATE TABLE memories_backup AS SELECT * FROM memories;

-- Step 2: Check current dimensions to understand data state
SELECT 
  array_length(embedding, 1) as dimension,
  COUNT(*) as count
FROM memories
WHERE embedding IS NOT NULL
GROUP BY dimension
ORDER BY dimension;

-- Step 3: Create a function to handle conversion from 384D to 1536D
CREATE OR REPLACE FUNCTION convert_384d_to_1536d(embedding_array float[]) 
RETURNS float[] AS $$
DECLARE
  new_array float[] := array_fill(0, ARRAY[1536]);
  dimension integer;
BEGIN
  -- If it's null, return null
  IF embedding_array IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Get the current dimension
  dimension := array_length(embedding_array, 1);
  
  -- If already 1536D, return as is
  IF dimension = 1536 THEN
    RETURN embedding_array;
  END IF;
  
  -- If 384D, expand to 1536D by repeating each value 4 times
  IF dimension = 384 THEN
    FOR i IN 1..dimension LOOP
      new_array[(i-1)*4+1] := embedding_array[i];
      new_array[(i-1)*4+2] := embedding_array[i];
      new_array[(i-1)*4+3] := embedding_array[i];
      new_array[(i-1)*4+4] := embedding_array[i];
    END LOOP;
    RETURN new_array;
  END IF;
  
  -- For other dimensions, pad with zeros to reach 1536
  -- (this is a fallback, ideally all vectors should be 384D or 1536D)
  FOR i IN 1..LEAST(dimension, 1536) LOOP
    new_array[i] := embedding_array[i];
  END LOOP;
  
  RETURN new_array;
END;
$$ LANGUAGE plpgsql;

-- Step 4: Verify if pgvector extension is installed and has the right version
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'vector'
  ) THEN
    RAISE EXCEPTION 'pgvector extension is not installed. Please install it first.';
  END IF;
END $$;

-- Step 5: Migration approach based on PostgreSQL version
DO $$
DECLARE
  pg_version integer;
BEGIN
  -- Get PostgreSQL version
  SELECT current_setting('server_version_num')::integer INTO pg_version;
  
  -- For PostgreSQL 15+ we can use direct casting
  IF pg_version >= 150000 THEN
    RAISE NOTICE 'Using PostgreSQL 15+ approach with direct column type change';
    
    -- Alter the column type directly (supported in PostgreSQL 15+)
    ALTER TABLE memories
      ALTER COLUMN embedding TYPE vector(1536)
      USING convert_384d_to_1536d(embedding)::vector(1536);
      
  -- For older PostgreSQL versions, use column replacement
  ELSE
    RAISE NOTICE 'Using column replacement approach for PostgreSQL < 15';
    
    -- Create a new column with the 1536D type
    ALTER TABLE memories ADD COLUMN embedding_new vector(1536);
    
    -- Update the new column with converted values
    UPDATE memories 
    SET embedding_new = convert_384d_to_1536d(embedding)::vector(1536)
    WHERE embedding IS NOT NULL;
    
    -- Create indexes on the new column if they existed on the old one
    -- (adjust index name and type as needed based on your schema)
    CREATE INDEX IF NOT EXISTS idx_memories_embedding_new ON memories USING ivfflat (embedding_new vector_cosine_ops);
    
    -- Drop the old column and rename the new one
    ALTER TABLE memories DROP COLUMN embedding;
    ALTER TABLE memories RENAME COLUMN embedding_new TO embedding;
  END IF;
END $$;

-- Step 6: Verify the migration was successful
SELECT 
  array_length(embedding, 1) as dimension,
  COUNT(*) as count
FROM memories
WHERE embedding IS NOT NULL
GROUP BY dimension
ORDER BY dimension;

-- Step 7: Check for any remaining 384D embeddings that might have been missed
SELECT id, array_length(embedding, 1) as dimension
FROM memories
WHERE embedding IS NOT NULL
  AND array_length(embedding, 1) != 1536;

-- Step 8: If everything looks good, you can drop the backup table (uncomment when ready)
-- DROP TABLE memories_backup;

-- Step 9: Update any database objects that might have hardcoded 384D dimensions
-- (check triggers, views, functions, etc.)
DO $$
DECLARE
  obj_record record;
BEGIN
  -- Find database objects that might contain '384' in their definition
  FOR obj_record IN 
    SELECT n.nspname as schema_name, p.proname as object_name, 
           pg_get_functiondef(p.oid) as definition
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE pg_get_functiondef(p.oid) LIKE '%384%'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  LOOP
    RAISE NOTICE 'Potential hardcoded 384D reference in function %.%: %',
      obj_record.schema_name, obj_record.object_name,
      substring(obj_record.definition from 1 for 100) || '...';
  END LOOP;
END $$;

-- Output success message
DO $$
BEGIN
  RAISE NOTICE 'Vector dimension migration completed!';
  RAISE NOTICE 'Please confirm all vectors are now 1536D dimensions with "SELECT array_length(embedding, 1)..."';
  RAISE NOTICE 'Remember to update any code that might be creating 384D vectors.';
END $$; 