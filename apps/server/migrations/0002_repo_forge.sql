-- Detected forge for the repo's origin host ('github' | 'gitlab' | 'none').
-- NULL until detected: set at registration, and lazily for rows that predate this column.
ALTER TABLE repo ADD COLUMN forge text;
