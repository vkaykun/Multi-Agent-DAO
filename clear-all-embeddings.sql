-- WARNING: THIS SCRIPT WILL CLEAR ALL EMBEDDINGS FROM YOUR DATABASE
-- ONLY USE THIS AS A LAST RESORT WHEN OTHER FIXES FAIL

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

-- Begin transaction
BEGIN;

-- Set embeddings to NULL in all tables that have embedding columns
DO $$
DECLARE
    row_count INT;
    total_tables INT := 0;
    total_rows INT := 0;
BEGIN
    FOR tbl IN 
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public'
    LOOP
        IF column_exists(tbl, 'embedding') THEN
            total_tables := total_tables + 1;
            
            EXECUTE format('
                UPDATE %I SET embedding = NULL WHERE embedding IS NOT NULL;
                GET DIAGNOSTICS row_count = ROW_COUNT;
            ', tbl);
            
            total_rows := total_rows + row_count;
            RAISE NOTICE 'Cleared embeddings from %: % rows affected', tbl, row_count;
        END IF;
    END LOOP;
    
    RAISE NOTICE 'Total: % tables processed, % rows cleared of embeddings', total_tables, total_rows;
END $$;

-- Verify the removals
DO $$
DECLARE
    remaining INT;
BEGIN
    FOR tbl IN 
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public'
    LOOP
        IF column_exists(tbl, 'embedding') THEN
            EXECUTE format('
                SELECT COUNT(*) FROM %I WHERE embedding IS NOT NULL
            ', tbl) INTO remaining;
            
            IF remaining > 0 THEN
                RAISE WARNING 'Table % still has % rows with embeddings', tbl, remaining;
            ELSE
                RAISE NOTICE 'Table % verified: 0 embeddings remaining', tbl;
            END IF;
        END IF;
    END LOOP;
END $$;

-- Commit transaction (uncomment to apply changes)
-- COMMIT;

-- IMPORTANT: By default this script is in a transaction that will be rolled back
-- To actually apply the changes, uncomment the COMMIT line above
-- Make sure you have a backup before doing this! 