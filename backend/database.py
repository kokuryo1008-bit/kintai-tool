"""データベース初期化・スキーマ定義"""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "kintai.db"


def get_conn():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_conn()
    cur = conn.cursor()

    cur.executescript("""
    CREATE TABLE IF NOT EXISTS company (
        id                  INTEGER PRIMARY KEY DEFAULT 1,
        name                TEXT NOT NULL DEFAULT '株式会社サンプル',
        lat                 REAL DEFAULT NULL,
        lng                 REAL DEFAULT NULL,
        gps_radius          INTEGER DEFAULT 500,
        work_hours          REAL DEFAULT 8.0,
        work_start          TEXT DEFAULT '09:00',
        default_leave_days  REAL DEFAULT 10,
        updated_at          TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS departments (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        created_at  TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS users (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id     TEXT UNIQUE NOT NULL,
        name            TEXT NOT NULL,
        role            TEXT NOT NULL DEFAULT 'employee',
        department_id   INTEGER REFERENCES departments(id),
        position        TEXT,
        email           TEXT,
        password_hash   TEXT,
        pin_hash        TEXT,
        annual_leave    INTEGER DEFAULT 10,
        used_leave      REAL DEFAULT 0,
        hire_date       TEXT,
        is_active       INTEGER DEFAULT 1,
        created_at      TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS attendance (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id          INTEGER NOT NULL REFERENCES users(id),
        work_date        TEXT NOT NULL,
        clock_in         TEXT,
        clock_out        TEXT,
        work_minutes     INTEGER DEFAULT 0,
        overtime_minutes INTEGER DEFAULT 0,
        location_type    TEXT DEFAULT 'office',
        note             TEXT,
        created_at       TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(user_id, work_date)
    );

    CREATE TABLE IF NOT EXISTS leave_requests (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        start_date  TEXT NOT NULL,
        end_date    TEXT NOT NULL,
        days        REAL NOT NULL,
        reason      TEXT,
        status      TEXT DEFAULT 'pending',
        approved_by INTEGER REFERENCES users(id),
        approved_at TEXT,
        created_at  TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS business_trips (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id),
        trip_date    TEXT NOT NULL,
        destination  TEXT NOT NULL,
        reason       TEXT,
        status       TEXT DEFAULT 'pending',
        approved_by  INTEGER REFERENCES users(id),
        approved_at  TEXT,
        created_at   TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS shifts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        shift_date  TEXT NOT NULL,
        start_time  TEXT NOT NULL,
        end_time    TEXT NOT NULL,
        note        TEXT,
        created_by  INTEGER REFERENCES users(id),
        created_at  TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(user_id, shift_date)
    );

    CREATE TABLE IF NOT EXISTS shift_templates (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        start_time  TEXT NOT NULL,
        end_time    TEXT NOT NULL,
        created_at  TEXT DEFAULT (datetime('now','localtime'))
    );
    """)
    conn.commit()

    if not cur.execute("SELECT 1 FROM company WHERE id=1").fetchone():
        cur.execute("INSERT INTO company (id) VALUES (1)")
        conn.commit()

    if not cur.execute("SELECT 1 FROM departments").fetchone():
        cur.execute("INSERT INTO departments (name) VALUES ('総務部')")
        conn.commit()

    if not cur.execute("SELECT 1 FROM shift_templates").fetchone():
        cur.executemany(
            "INSERT INTO shift_templates (name, start_time, end_time) VALUES (?,?,?)",
            [("日勤", "09:00", "18:00"), ("早番", "07:00", "16:00"), ("遅番", "12:00", "21:00")],
        )
        conn.commit()

    conn.close()
