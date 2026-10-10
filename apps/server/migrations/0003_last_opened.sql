-- Homebase "unread agent replies": agent comments created after the
-- review was last opened count as unread; NULL (never opened) means every
-- agent comment counts. `GET /api/reviews/:id` sets this to `unixepoch()`
-- after building its response, so opening the review marks the window read.
ALTER TABLE review ADD COLUMN last_opened_at integer;
