"""データベース初期化・スキーマ定義"""
import sqlite3
import os
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
        id          INTEGER PRIMARY KEY DEFAULT 1,
        name        TEXT NOT NULL DEFAULT '株式会社サンプル',
        lat         REAL DEFAULT NULL,
        lng         REAL DEFAULT NULL,
        gps_radius  INTEGER DEFAULT 500,
        work_hours  REAL DEFAULT 8.0,
        work_start  TEXT DEFAULT '09:00',
        updated_at  TEXT DEFAULT (datetime('now','localtime'))
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
        role            TEXT NOT NULL DEFAULT 'employee',  -- admin / manager / employee
        department_id   INTEGER REFERENCES departments(id),
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
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL REFERENCES users(id),
        work_date       TEXT NOT NULL,
        clock_in        TEXT,
        clock_out       TEXT,
        work_minutes    INTEGER DEFAULT 0,
        overtime_minutes INTEGER DEFAULT 0,
        location_type   TEXT DEFAULT 'office',  -- office / business_trip / remote
        note            TEXT,
        created_at      TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(user_id, work_date)
    );

    CREATE TABLE IF NOT EXISTS leave_requests (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        start_date  TEXT NOT NULL,
        end_date    TEXT NOT NULL,
        days        REAL NOT NULL,
        reason      TEXT,
        status      TEXT DEFAULT 'pending',  -- pending / approved / rejected
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
        status       TEXT DEFAULT 'pending',  -- pending / approved / rejected
        approved_by  INTEGER REFERENCES users(id),
        approved_at  TEXT,
        created_at   TEXT DEFAULT (datetime('now','localtime'))
    );
    """)
    conn.commit()

    # 後から追加したカラムをマイグレーション
    _migrate(cur)

    # 会社レコードが未登録なら初期データ挿入
    if not cur.execute("SELECT 1 FROM company WHERE id=1").fetchone():
        cur.execute("INSERT INTO company (id) VALUES (1)")
        conn.commit()

    # デフォルト事業部
    if not cur.execute("SELECT 1 FROM departments").fetchone():
        cur.execute("INSERT INTO departments (name) VALUES ('総務部')")
        conn.commit()

    conn.close()


def _migrate(cur):
    existing = {row[1] for row in cur.execute("PRAGMA table_info(users)")}
    if "position" not in existing:
        cur.execute("ALTER TABLE users ADD COLUMN position TEXT")
    existing_c = {row[1] for row in cur.execute("PRAGMA table_info(company)")}
    if "default_leave_days" not in existing_c:
        cur.execute("ALTER TABLE company ADD COLUMN default_leave_days REAL DEFAULT 10")
