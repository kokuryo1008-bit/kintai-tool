"""データベース — SQLite（ローカル）/ PostgreSQL（本番）自動切り替え"""
import os
import re
import sqlite3
from pathlib import Path

DATABASE_URL = os.getenv("DATABASE_URL")  # 本番: Supabase/Neon の接続URL

# ── PostgreSQL用SQLアダプター ─────────────────────────────────────────────────

def _pg_sql(sql: str) -> str:
    """SQLite構文をPostgreSQL構文に変換"""
    sql = sql.replace("?", "%s")
    sql = sql.replace("datetime('now','localtime')", "CURRENT_TIMESTAMP")
    sql = sql.replace("datetime('now')", "CURRENT_TIMESTAMP")
    sql = re.sub(
        r"strftime\('%Y-%m',\s*([a-zA-Z_.]+)\)",
        r"TO_CHAR(\1::date,'YYYY-MM')",
        sql,
    )
    sql = re.sub(
        r"strftime\('%Y',\s*([a-zA-Z_.]+)\)",
        r"TO_CHAR(\1::date,'YYYY')",
        sql,
    )
    return sql


class _PGCursor:
    def __init__(self, cur):
        self._cur = cur

    def fetchone(self):
        row = self._cur.fetchone()
        if row is None:
            return None
        cols = [d[0] for d in self._cur.description]
        return _DictRow(dict(zip(cols, row)))

    def fetchall(self):
        rows = self._cur.fetchall()
        if not rows:
            return []
        cols = [d[0] for d in self._cur.description]
        return [_DictRow(dict(zip(cols, r))) for r in rows]

    def __getitem__(self, idx):
        return self._cur.fetchall()[idx]


class _DictRow(dict):
    """dict だが row["key"] と row[0] 両方でアクセス可能"""
    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)


class _PGConn:
    """PostgreSQL接続をsqlite3風に見せるラッパー"""

    def __init__(self, raw):
        self._raw = raw

    def execute(self, sql, params=()):
        cur = self._raw.cursor()
        cur.execute(_pg_sql(sql), list(params))
        return _PGCursor(cur)

    def executemany(self, sql, params_list):
        cur = self._raw.cursor()
        for p in params_list:
            cur.execute(_pg_sql(sql), list(p))

    def executescript(self, sql):
        """DDL用: セミコロンで分割して順次実行"""
        cur = self._raw.cursor()
        for stmt in sql.split(";"):
            stmt = stmt.strip()
            if not stmt:
                continue
            stmt = _pg_ddl(stmt)
            try:
                cur.execute(stmt)
            except Exception:
                self._raw.rollback()

    def rollback(self):
        self._raw.rollback()

    def commit(self):
        self._raw.commit()

    def close(self):
        self._raw.close()


def _pg_ddl(sql: str) -> str:
    """SQLite DDL → PostgreSQL DDL 変換"""
    sql = re.sub(r"\bINTEGER PRIMARY KEY AUTOINCREMENT\b", "SERIAL PRIMARY KEY", sql, flags=re.I)
    sql = sql.replace("datetime('now','localtime')", "CURRENT_TIMESTAMP")
    sql = sql.replace("datetime('now')", "CURRENT_TIMESTAMP")
    # REAL → NUMERIC（互換あり、省略可）
    return sql


# ── 接続取得 ──────────────────────────────────────────────────────────────────

_DB_PATH = Path(__file__).parent.parent / "data" / "kintai.db"


def get_conn():
    if DATABASE_URL:
        import psycopg2
        url = DATABASE_URL
        if "sslmode" not in url:
            url += ("&" if "?" in url else "?") + "sslmode=require"
        raw = psycopg2.connect(url)
        raw.autocommit = False
        return _PGConn(raw)
    else:
        _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn


# ── スキーマ初期化 ────────────────────────────────────────────────────────────

_SCHEMA = """
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
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    weekly_off_days TEXT DEFAULT '',
    dept_work_start TEXT DEFAULT NULL,
    dept_work_end   TEXT DEFAULT NULL,
    created_at      TEXT DEFAULT (datetime('now','localtime'))
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

CREATE TABLE IF NOT EXISTS holidays (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    holiday_date TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS mandatory_leaves (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    fiscal_year INTEGER NOT NULL,
    leave_date  TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(user_id, leave_date)
);

CREATE TABLE IF NOT EXISTS daily_reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    report_date  TEXT NOT NULL,
    part_number  TEXT,
    estimate_no  TEXT,
    work_code    TEXT,
    board_start  TEXT,
    board_end    TEXT,
    other_code   TEXT,
    other_start  TEXT,
    other_end    TEXT,
    created_at   TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sales_reports (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    report_date    TEXT NOT NULL,
    client_company TEXT NOT NULL,
    client_dept    TEXT,
    client_name    TEXT,
    purpose        TEXT,
    content        TEXT,
    amount         INTEGER,
    status         TEXT,
    next_action    TEXT,
    next_date      TEXT,
    created_at     TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS overtime_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    work_date   TEXT NOT NULL,
    planned_end TEXT,
    reason      TEXT,
    status      TEXT DEFAULT 'pending',
    approved_by INTEGER REFERENCES users(id),
    approved_at TEXT,
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(user_id, work_date)
)
"""


def init_db():
    conn = get_conn()
    conn.executescript(_SCHEMA)
    conn.commit()

    # Migration: daily_reports table
    try:
        conn.executescript("""CREATE TABLE IF NOT EXISTS daily_reports (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL REFERENCES users(id),
            report_date  TEXT NOT NULL,
            part_number  TEXT,
            estimate_no  TEXT,
            work_code    TEXT,
            board_start  TEXT,
            board_end    TEXT,
            other_code   TEXT,
            other_start  TEXT,
            other_end    TEXT,
            created_at   TEXT DEFAULT (datetime('now','localtime'))
        )""")
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass

    # Migration: sales_reports table
    try:
        conn.executescript("""CREATE TABLE IF NOT EXISTS sales_reports (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id        INTEGER NOT NULL REFERENCES users(id),
            report_date    TEXT NOT NULL,
            client_company TEXT NOT NULL,
            client_dept    TEXT,
            client_name    TEXT,
            purpose        TEXT,
            content        TEXT,
            amount         INTEGER,
            status         TEXT,
            next_action    TEXT,
            next_date      TEXT,
            created_at     TEXT DEFAULT (datetime('now','localtime'))
        )""")
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass

    # Migration: weekly_off_days column
    try:
        conn.execute("ALTER TABLE departments ADD COLUMN weekly_off_days TEXT DEFAULT ''")
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass

    # Migration: dept_work_start / dept_work_end columns
    for col in ("dept_work_start TEXT DEFAULT NULL", "dept_work_end TEXT DEFAULT NULL"):
        try:
            conn.execute(f"ALTER TABLE departments ADD COLUMN {col}")
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass

    # Migration: overtime_requests table
    try:
        conn.executescript("""CREATE TABLE IF NOT EXISTS overtime_requests (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL REFERENCES users(id),
            work_date   TEXT NOT NULL,
            planned_end TEXT,
            reason      TEXT,
            status      TEXT DEFAULT 'pending',
            approved_by INTEGER REFERENCES users(id),
            approved_at TEXT,
            created_by  INTEGER REFERENCES users(id),
            created_at  TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(user_id, work_date)
        )""")
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass

    # Migration: overtime_requests.created_by column
    try:
        conn.execute("ALTER TABLE overtime_requests ADD COLUMN created_by INTEGER REFERENCES users(id)")
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass

    # Migration: external_records table（外出・帰社）
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS external_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id),
                work_date TEXT NOT NULL,
                out_time TEXT NOT NULL,
                in_time TEXT,
                note TEXT,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            )
        """)
        conn.commit()
    except Exception:
        try: conn.rollback()
        except Exception: pass

    # Migration: break_minutes column
    try:
        conn.execute("ALTER TABLE company ADD COLUMN break_minutes INTEGER DEFAULT 60")
        conn.commit()
    except Exception:
        try: conn.rollback()
        except Exception: pass

    # Migration: per-user work schedule
    for col in ("work_start TEXT DEFAULT NULL", "work_end TEXT DEFAULT NULL"):
        try:
            conn.execute(f"ALTER TABLE users ADD COLUMN {col}")
            conn.commit()
        except Exception:
            try: conn.rollback()
            except Exception: pass

    # Migration: punch_correction_requests table
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS punch_correction_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id),
                work_date TEXT NOT NULL,
                requested_clock_in TEXT,
                requested_clock_out TEXT,
                reason TEXT,
                status TEXT DEFAULT 'pending',
                approved_by INTEGER REFERENCES users(id),
                approved_at TEXT,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            )
        """)
        conn.commit()
    except Exception:
        try: conn.rollback()
        except Exception: pass

    if not conn.execute("SELECT 1 FROM company WHERE id=1").fetchone():
        conn.execute("INSERT INTO company (id) VALUES (1)")
        conn.commit()

    if not conn.execute("SELECT 1 FROM departments").fetchone():
        conn.execute("INSERT INTO departments (name) VALUES (?)", ("総務部",))
        conn.commit()

    if not conn.execute("SELECT 1 FROM shift_templates").fetchone():
        conn.executemany(
            "INSERT INTO shift_templates (name, start_time, end_time) VALUES (?,?,?)",
            [("日勤", "09:00", "18:00"), ("早番", "07:00", "16:00"), ("遅番", "12:00", "21:00")],
        )
        conn.commit()

    conn.close()
