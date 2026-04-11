import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "courses.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
  }
  return _db;
}

export function initDb() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offering_name TEXT NOT NULL,
      section_name TEXT NOT NULL,
      title TEXT NOT NULL,
      credits TEXT,
      department TEXT,
      school_name TEXT,
      level TEXT,
      status TEXT,
      dow TEXT,
      time_of_day TEXT,
      meetings TEXT,
      location TEXT,
      building TEXT,
      instruction_method TEXT,
      instructors TEXT,
      instructors_full_name TEXT,
      max_seats TEXT,
      open_seats TEXT,
      waitlisted TEXT,
      is_writing_intensive TEXT,
      areas TEXT,
      repeatable TEXT,
      term TEXT,
      term_start_date TEXT,
      UNIQUE(offering_name, section_name, term)
    );

    CREATE INDEX IF NOT EXISTS idx_courses_title ON courses(title);
    CREATE INDEX IF NOT EXISTS idx_courses_department ON courses(department);
    CREATE INDEX IF NOT EXISTS idx_courses_school ON courses(school_name);
    CREATE INDEX IF NOT EXISTS idx_courses_status ON courses(status);
    CREATE INDEX IF NOT EXISTS idx_courses_level ON courses(level);
    CREATE INDEX IF NOT EXISTS idx_courses_meetings ON courses(meetings);
    CREATE INDEX IF NOT EXISTS idx_courses_instructors ON courses(instructors_full_name);
  `);
  return db;
}
