-- SQL Script to fix vector dimension issues
-- Run this against your database to prevent dimension mismatch errors

-- Function to safely determine if a column exists
CREATE OR REPLACE FUNCTION column_exists(tbl text, col text) RETURNS boolean AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = tbl AND column_name = col
    );
END;
$$ LANGUAGE plpgsql;

-- Function to determine if pgvector extension is installed
CREATE OR REPLACE FUNCTION is_pgvector_installed() RETURNS boolean AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 
        FROM pg_extension 
        WHERE extname = 'vector'
    );
END;
$$ LANGUAGE plpgsql;

-- Step 1: Check if pgvector extension is installed
DO $$
BEGIN
    IF NOT is_pgvector_installed() THEN
        RAISE NOTICE 'pgvector extension is not installed, no need to fix dimensions';
        RETURN;
    END IF;
    
    RAISE NOTICE 'pgvector extension is installed, proceeding with fixes';
    
    -- Step 2: Modify all memories tables to allow NULL embeddings
    FOR tbl IN 
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND 
              table_name LIKE '%memories%'
    LOOP
        IF column_exists(tbl, 'embedding') THEN
            EXECUTE format('ALTER TABLE %I ALTER COLUMN embedding DROP NOT NULL;', tbl);
            RAISE NOTICE 'Modified %: embedding column now allows NULL values', tbl;
            
            -- Add a trigger to handle dimensions
            EXECUTE format('
                CREATE OR REPLACE FUNCTION %I_embedding_trigger()
                RETURNS TRIGGER AS $$
                BEGIN
                    -- If embeddings are present, verify dimension
                    IF NEW.embedding IS NOT NULL THEN
                        -- Option 1: Standardize to 384 dimensions
                        IF array_length(NEW.embedding, 1) = 1536 THEN
                            -- Truncate to 384 dimensions
                            NEW.embedding = NEW.embedding[1:384];
                            RAISE NOTICE ''Truncated embedding from 1536 to 384 dimensions'';
                        END IF;
                        
                        -- Validate dimensions
                        IF array_length(NEW.embedding, 1) != 384 THEN
                            RAISE NOTICE ''Invalid embedding dimension, setting to NULL'';
                            NEW.embedding = NULL;
                        END IF;
                    END IF;
                    
                    RETURN NEW;
                END;
                $$ LANGUAGE plpgsql;
                
                DROP TRIGGER IF EXISTS handle_embedding_dimensions ON %I;
                CREATE TRIGGER handle_embedding_dimensions
                BEFORE INSERT OR UPDATE ON %I
                FOR EACH ROW
                EXECUTE FUNCTION %I_embedding_trigger();
            ', tbl, tbl, tbl, tbl);
            
            RAISE NOTICE 'Added dimension handling trigger to %', tbl;
        END IF;
    END LOOP;
    
    RAISE NOTICE 'All vector dimension fixes applied successfully';
END $$; 