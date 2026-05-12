"""勤怠管理ツール - バックエンド"""
import math
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent))
from auth import (create_token, get_current_user, hash_password,
                  require_admin, verify_password)
from database import get_conn, init_db

load_dotenv()

app = FastAPI(title="勤怠管理システム", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.on_event("startup")
def startup():
    init_db()
    _create_default_admin()


def _create_default_admin():
    conn = get_conn()
    exists = conn.execute("SELECT 1 FROM users WHERE role='admin'").fetchone()
    if not exists:
        conn.execute(
            "INSERT INTO users (employee_id,name,role,password_hash,pin_hash,hire_date) VALUES (?,?,?,?,?,?)",
            ("admin", "管理者", "admin", hash_password("admin1234"), hash_password("0000"), date.today().isoformat()),
        )
        conn.commit()
        print("デフォルト管理者: ID=admin / PW=admin1234")
    conn.close()


# ── GPS ──────────────────────────────────────────────────────────────────────

def haversine(lat1, lon1, lat2, lon2) -> float:
    R = 6371000
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _check_gps(lat, lon, conn, user_id, today, location_type="office"):
    if location_type == "business_trip":
        return
    company = conn.execute("SELECT lat, lng, gps_radius FROM company WHERE id=1").fetchone()
    if not company or company["lat"] is None:
        return
    if lat is None or lon is None:
        raise HTTPException(status_code=400, detail="GPS情報が取得できません。位置情報を許可してください。")
    dist = haversine(lat, lon, company["lat"], company["lng"])
    if dist > company["gps_radius"]:
        raise HTTPException(
            status_code=403,
            detail=f"会社から{int(dist)}m離れています（許可範囲: {company['gps_radius']}m）。出張の場合は出張申請してください。",
        )


def _calc_hours(conn, user_id: int, work_date: str):
    row = conn.execute(
        "SELECT clock_in, clock_out FROM attendance WHERE user_id=? AND work_date=?",
        (user_id, work_date),
    ).fetchone()
    if not row or not row["clock_in"] or not row["clock_out"]:
        return
    company = conn.execute("SELECT work_hours FROM company WHERE id=1").fetchone()
    std_min = int((company["work_hours"] if company else 8.0) * 60)
    ci = datetime.strptime(f"{work_date} {row['clock_in']}", "%Y-%m-%d %H:%M:%S")
    co = datetime.strptime(f"{work_date} {row['clock_out']}", "%Y-%m-%d %H:%M:%S")
    if co < ci:
        co += timedelta(days=1)
    total = int((co - ci).total_seconds() / 60)
    overtime = max(0, total - std_min)
    conn.execute(
        "UPDATE attendance SET work_minutes=?, overtime_minutes=? WHERE user_id=? AND work_date=?",
        (total, overtime, user_id, work_date),
    )


# ── ページ配信 ────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return FileResponse(str(FRONTEND_DIR / "login.html"))

@app.get("/employee")
def employee_page():
    return FileResponse(str(FRONTEND_DIR / "employee.html"))

@app.get("/admin")
def admin_page():
    return FileResponse(str(FRONTEND_DIR / "admin.html"))


# ── 認証 ──────────────────────────────────────────────────────────────────────

class LoginReq(BaseModel):
    employee_id: str
    password: str

@app.post("/api/login")
def login(req: LoginReq):
    conn = get_conn()
    user = conn.execute(
        "SELECT id, name, role, password_hash, pin_hash FROM users WHERE employee_id=? AND is_active=1",
        (req.employee_id,),
    ).fetchone()
    conn.close()
    if not user:
        raise HTTPException(status_code=401, detail="社員IDまたはパスワードが違います。")
    ok = verify_password(req.password, user["password_hash"] or "") or verify_password(req.password, user["pin_hash"] or "")
    if not ok:
        raise HTTPException(status_code=401, detail="社員IDまたはパスワードが違います。")
    return {"token": create_token(user["id"], user["role"]), "role": user["role"], "name": user["name"]}


# ── 会社設定 ──────────────────────────────────────────────────────────────────

class CompanySettingsReq(BaseModel):
    name: Optional[str] = None
    office_lat: Optional[float] = None
    office_lon: Optional[float] = None
    gps_radius: Optional[int] = None

class WorkSettingsReq(BaseModel):
    work_hours_per_day: Optional[float] = None
    default_leave_days: Optional[float] = None

@app.get("/api/company/settings")
def get_company_settings(user=Depends(get_current_user)):
    conn = get_conn()
    row = conn.execute("SELECT * FROM company WHERE id=1").fetchone()
    conn.close()
    d = dict(row)
    return {
        "name": d.get("name"),
        "office_lat": d.get("lat"),
        "office_lon": d.get("lng"),
        "gps_radius": d.get("gps_radius", 500),
        "work_hours_per_day": d.get("work_hours", 8.0),
        "default_leave_days": d.get("default_leave_days", 10),
    }

@app.put("/api/company/settings")
def update_company_settings(req: CompanySettingsReq, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    conn.execute("""
        UPDATE company SET
            name=COALESCE(?, name),
            lat=COALESCE(?, lat),
            lng=COALESCE(?, lng),
            gps_radius=COALESCE(?, gps_radius),
            updated_at=datetime('now','localtime')
        WHERE id=1
    """, (req.name, req.office_lat, req.office_lon, req.gps_radius))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.put("/api/company/work-settings")
def update_work_settings(req: WorkSettingsReq, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    conn.execute("""
        UPDATE company SET
            work_hours=COALESCE(?, work_hours),
            default_leave_days=COALESCE(?, default_leave_days),
            updated_at=datetime('now','localtime')
        WHERE id=1
    """, (req.work_hours_per_day, req.default_leave_days))
    conn.commit()
    conn.close()
    return {"ok": True}


# ── 部署 ──────────────────────────────────────────────────────────────────────

class DeptReq(BaseModel):
    name: str

@app.get("/api/departments")
def get_departments(user=Depends(get_current_user)):
    conn = get_conn()
    rows = conn.execute("SELECT id, name FROM departments ORDER BY id").fetchall()
    conn.close()
    return {"departments": [dict(r) for r in rows]}

@app.post("/api/departments")
def create_department(req: DeptReq, user=Depends(get_current_user)):
    require_admin(user)
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="部署名を入力してください。")
    conn = get_conn()
    conn.execute("INSERT INTO departments (name) VALUES (?)", (name,))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.delete("/api/departments/{dept_id}")
def delete_department(dept_id: int, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    conn.execute("DELETE FROM departments WHERE id=?", (dept_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ── 出退勤（従業員） ──────────────────────────────────────────────────────────

class ClockReq(BaseModel):
    lat: Optional[float] = None
    lon: Optional[float] = None
    location_type: str = "office"

@app.get("/api/attendance/today")
def attendance_today(user=Depends(get_current_user)):
    today = date.today().isoformat()
    conn = get_conn()
    row = conn.execute(
        "SELECT clock_in, clock_out, work_minutes, overtime_minutes FROM attendance WHERE user_id=? AND work_date=?",
        (user["id"], today),
    ).fetchone()
    conn.close()
    if not row:
        return {"clock_in": None, "clock_out": None, "work_minutes": None, "overtime_minutes": None}
    return {
        "clock_in": row["clock_in"],
        "clock_out": row["clock_out"],
        "work_minutes": row["work_minutes"],
        "overtime_minutes": row["overtime_minutes"],
    }

@app.post("/api/attendance/clock-in")
def clock_in(req: ClockReq, user=Depends(get_current_user)):
    today = date.today().isoformat()
    now_time = datetime.now().strftime("%H:%M:%S")
    conn = get_conn()
    _check_gps(req.lat, req.lon, conn, user["id"], today, req.location_type)
    existing = conn.execute(
        "SELECT clock_in FROM attendance WHERE user_id=? AND work_date=?", (user["id"], today)
    ).fetchone()
    if existing and existing["clock_in"]:
        conn.close()
        raise HTTPException(status_code=400, detail="本日はすでに出勤打刻済みです。")
    conn.execute("""
        INSERT INTO attendance (user_id, work_date, clock_in, location_type)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, work_date) DO UPDATE SET clock_in=excluded.clock_in, location_type=excluded.location_type
    """, (user["id"], today, now_time, req.location_type))
    conn.commit()
    conn.close()
    return {"ok": True, "clock_in": now_time}

@app.post("/api/attendance/clock-out")
def clock_out(req: ClockReq, user=Depends(get_current_user)):
    today = date.today().isoformat()
    now_time = datetime.now().strftime("%H:%M:%S")
    conn = get_conn()
    row = conn.execute(
        "SELECT clock_in, clock_out FROM attendance WHERE user_id=? AND work_date=?", (user["id"], today)
    ).fetchone()
    if not row or not row["clock_in"]:
        conn.close()
        raise HTTPException(status_code=400, detail="出勤打刻がありません。")
    if row["clock_out"]:
        conn.close()
        raise HTTPException(status_code=400, detail="本日はすでに退勤打刻済みです。")
    conn.execute(
        "UPDATE attendance SET clock_out=? WHERE user_id=? AND work_date=?",
        (now_time, user["id"], today),
    )
    _calc_hours(conn, user["id"], today)
    conn.commit()
    conn.close()
    return {"ok": True, "clock_out": now_time}

@app.get("/api/attendance/history")
def attendance_history(year: int = None, month: int = None, user=Depends(get_current_user)):
    today = date.today()
    y = year or today.year
    m = month or today.month
    conn = get_conn()
    rows = conn.execute(
        "SELECT work_date as date, clock_in, clock_out, work_minutes, overtime_minutes FROM attendance WHERE user_id=? AND strftime('%Y-%m', work_date)=? ORDER BY work_date",
        (user["id"], f"{y:04d}-{m:02d}"),
    ).fetchall()
    conn.close()
    return {"records": [dict(r) for r in rows]}


# ── 有給申請（従業員） ────────────────────────────────────────────────────────

class LeaveReq(BaseModel):
    start_date: str
    end_date: str
    days: float
    reason: Optional[str] = None

@app.get("/api/leave/remaining")
def leave_remaining(user=Depends(get_current_user)):
    remaining = (user["annual_leave"] or 10) - (user["used_leave"] or 0)
    return {"remaining_days": remaining}

@app.get("/api/leave/history")
def leave_history(user=Depends(get_current_user)):
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, start_date, end_date, days, reason, status, created_at FROM leave_requests WHERE user_id=? ORDER BY created_at DESC",
        (user["id"],),
    ).fetchall()
    conn.close()
    return {"requests": [dict(r) for r in rows]}

@app.post("/api/leave/request")
def request_leave(req: LeaveReq, user=Depends(get_current_user)):
    remaining = (user["annual_leave"] or 10) - (user["used_leave"] or 0)
    if req.days > remaining:
        raise HTTPException(status_code=400, detail=f"有給残数が不足しています（残: {remaining}日）。")
    conn = get_conn()
    conn.execute(
        "INSERT INTO leave_requests (user_id, start_date, end_date, days, reason) VALUES (?,?,?,?,?)",
        (user["id"], req.start_date, req.end_date, req.days, req.reason),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


# ── 出張申請（従業員） ────────────────────────────────────────────────────────

class TripReq(BaseModel):
    trip_date: str
    destination: str
    reason: Optional[str] = None

@app.get("/api/trips/history")
def trip_history(user=Depends(get_current_user)):
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, trip_date, destination, reason, status, created_at FROM business_trips WHERE user_id=? ORDER BY created_at DESC",
        (user["id"],),
    ).fetchall()
    conn.close()
    return {"requests": [dict(r) for r in rows]}

@app.post("/api/trips/request")
def request_trip(req: TripReq, user=Depends(get_current_user)):
    conn = get_conn()
    conn.execute(
        "INSERT INTO business_trips (user_id, trip_date, destination, reason) VALUES (?,?,?,?)",
        (user["id"], req.trip_date, req.destination, req.reason),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


# ── 管理者API ─────────────────────────────────────────────────────────────────

@app.get("/api/admin/stats")
def admin_stats(user=Depends(get_current_user)):
    require_admin(user)
    today = date.today().isoformat()
    conn = get_conn()
    total = conn.execute("SELECT COUNT(*) FROM users WHERE is_active=1 AND role='employee'").fetchone()[0]
    present = conn.execute(
        "SELECT COUNT(*) FROM attendance a JOIN users u ON a.user_id=u.id WHERE a.work_date=? AND a.clock_in IS NOT NULL AND u.is_active=1",
        (today,),
    ).fetchone()[0]
    p_leave = conn.execute("SELECT COUNT(*) FROM leave_requests WHERE status='pending'").fetchone()[0]
    p_trip = conn.execute("SELECT COUNT(*) FROM business_trips WHERE status='pending'").fetchone()[0]
    conn.close()
    return {"total_employees": total, "today_present": present, "pending_leave": p_leave, "pending_trip": p_trip}

@app.get("/api/admin/today")
def admin_today(user=Depends(get_current_user)):
    require_admin(user)
    today = date.today().isoformat()
    conn = get_conn()
    rows = conn.execute("""
        SELECT u.name, d.name as department, a.clock_in, a.clock_out
        FROM users u
        LEFT JOIN departments d ON u.department_id=d.id
        LEFT JOIN attendance a ON a.user_id=u.id AND a.work_date=?
        WHERE u.is_active=1 AND u.role='employee'
        ORDER BY d.name, u.employee_id
    """, (today,)).fetchall()
    conn.close()
    return {"records": [dict(r) for r in rows]}


# ── 従業員管理 ────────────────────────────────────────────────────────────────

class EmpCreate(BaseModel):
    employee_id: str
    name: str
    password: Optional[str] = None
    department_id: Optional[int] = None
    position: Optional[str] = None
    role: str = "employee"
    leave_remaining: float = 10.0

class EmpUpdate(BaseModel):
    name: Optional[str] = None
    password: Optional[str] = None
    department_id: Optional[int] = None
    position: Optional[str] = None
    role: Optional[str] = None
    leave_remaining: Optional[float] = None

@app.get("/api/admin/employees")
def admin_list_employees(user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    rows = conn.execute("""
        SELECT u.employee_id, u.name, d.name as department, u.position,
               u.role, (u.annual_leave - COALESCE(u.used_leave,0)) as leave_remaining
        FROM users u LEFT JOIN departments d ON u.department_id=d.id
        WHERE u.is_active=1 AND u.role != 'admin'
        ORDER BY d.name, u.employee_id
    """).fetchall()
    conn.close()
    return {"employees": [dict(r) for r in rows]}

@app.get("/api/admin/employees/{emp_id}")
def admin_get_employee(emp_id: str, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    row = conn.execute("""
        SELECT u.employee_id, u.name, u.position, u.role, u.department_id,
               (u.annual_leave - COALESCE(u.used_leave,0)) as leave_remaining
        FROM users u WHERE u.employee_id=? AND u.is_active=1
    """, (emp_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="従業員が見つかりません。")
    return dict(row)

@app.post("/api/admin/employees")
def admin_create_employee(req: EmpCreate, user=Depends(get_current_user)):
    require_admin(user)
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="氏名を入力してください。")
    if not req.employee_id.strip():
        raise HTTPException(status_code=400, detail="社員IDを入力してください。")
    pw_hash = hash_password(req.password) if req.password else hash_password("password")
    conn = get_conn()
    try:
        conn.execute("""
            INSERT INTO users (employee_id, name, role, department_id, position, password_hash, pin_hash, annual_leave, hire_date)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (req.employee_id.strip(), req.name.strip(), req.role, req.department_id,
              req.position, pw_hash, pw_hash, req.leave_remaining, date.today().isoformat()))
        conn.commit()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"登録エラー: {str(e)}")
    finally:
        conn.close()
    return {"ok": True}

@app.put("/api/admin/employees/{emp_id}")
def admin_update_employee(emp_id: str, req: EmpUpdate, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    if req.name is not None:
        conn.execute("UPDATE users SET name=? WHERE employee_id=?", (req.name, emp_id))
    if req.password:
        h = hash_password(req.password)
        conn.execute("UPDATE users SET password_hash=?, pin_hash=? WHERE employee_id=?", (h, h, emp_id))
    if req.department_id is not None:
        conn.execute("UPDATE users SET department_id=? WHERE employee_id=?", (req.department_id or None, emp_id))
    if req.position is not None:
        conn.execute("UPDATE users SET position=? WHERE employee_id=?", (req.position, emp_id))
    if req.role is not None:
        conn.execute("UPDATE users SET role=? WHERE employee_id=?", (req.role, emp_id))
    if req.leave_remaining is not None:
        conn.execute("UPDATE users SET annual_leave=?, used_leave=0 WHERE employee_id=?", (req.leave_remaining, emp_id))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.delete("/api/admin/employees/{emp_id}")
def admin_delete_employee(emp_id: str, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    conn.execute("UPDATE users SET is_active=0 WHERE employee_id=? AND role!='admin'", (emp_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ── 勤怠一覧（管理者） ────────────────────────────────────────────────────────

@app.get("/api/admin/attendance")
def admin_attendance(year: int = None, month: int = None, department_id: int = None, user=Depends(get_current_user)):
    require_admin(user)
    today = date.today()
    y = year or today.year
    m = month or today.month
    conn = get_conn()
    q = """
        SELECT a.work_date as date, u.name, d.name as department,
               a.clock_in, a.clock_out, a.work_minutes, a.overtime_minutes
        FROM attendance a
        JOIN users u ON a.user_id=u.id
        LEFT JOIN departments d ON u.department_id=d.id
        WHERE strftime('%Y-%m', a.work_date)=?
    """
    params = [f"{y:04d}-{m:02d}"]
    if department_id:
        q += " AND u.department_id=?"
        params.append(department_id)
    q += " ORDER BY a.work_date DESC, d.name, u.employee_id"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return {"records": [dict(r) for r in rows]}


# ── 有給申請管理（管理者） ────────────────────────────────────────────────────

@app.get("/api/admin/leave")
def admin_leave_list(status: str = "", user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    q = """
        SELECT lr.id, u.name, d.name as department,
               lr.start_date, lr.end_date, lr.days, lr.reason, lr.status, lr.created_at
        FROM leave_requests lr
        JOIN users u ON lr.user_id=u.id
        LEFT JOIN departments d ON u.department_id=d.id
    """
    params = []
    if status:
        q += " WHERE lr.status=?"
        params.append(status)
    q += " ORDER BY lr.created_at DESC"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return {"requests": [dict(r) for r in rows]}

@app.post("/api/admin/leave/{req_id}/approve")
def admin_approve_leave(req_id: int, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    row = conn.execute("SELECT * FROM leave_requests WHERE id=? AND status='pending'", (req_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="申請が見つかりません。")
    conn.execute(
        "UPDATE leave_requests SET status='approved', approved_by=?, approved_at=datetime('now','localtime') WHERE id=?",
        (user["id"], req_id),
    )
    conn.execute("UPDATE users SET used_leave=used_leave+? WHERE id=?", (row["days"], row["user_id"]))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.post("/api/admin/leave/{req_id}/reject")
def admin_reject_leave(req_id: int, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    conn.execute(
        "UPDATE leave_requests SET status='rejected', approved_by=?, approved_at=datetime('now','localtime') WHERE id=?",
        (user["id"], req_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


# ── 出張申請管理（管理者） ────────────────────────────────────────────────────

@app.get("/api/admin/trips")
def admin_trip_list(status: str = "", user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    q = """
        SELECT bt.id, u.name, d.name as department,
               bt.trip_date, bt.destination, bt.reason, bt.status, bt.created_at
        FROM business_trips bt
        JOIN users u ON bt.user_id=u.id
        LEFT JOIN departments d ON u.department_id=d.id
    """
    params = []
    if status:
        q += " WHERE bt.status=?"
        params.append(status)
    q += " ORDER BY bt.created_at DESC"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return {"requests": [dict(r) for r in rows]}

@app.post("/api/admin/trips/{trip_id}/approve")
def admin_approve_trip(trip_id: int, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    conn.execute(
        "UPDATE business_trips SET status='approved', approved_by=?, approved_at=datetime('now','localtime') WHERE id=? AND status='pending'",
        (user["id"], trip_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}

@app.post("/api/admin/trips/{trip_id}/reject")
def admin_reject_trip(trip_id: int, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    conn.execute(
        "UPDATE business_trips SET status='rejected', approved_by=?, approved_at=datetime('now','localtime') WHERE id=? AND status='pending'",
        (user["id"], trip_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


# ── シフト（従業員） ──────────────────────────────────────────────────────────

@app.get("/api/shifts/today")
def shift_today(user=Depends(get_current_user)):
    today = date.today().isoformat()
    conn = get_conn()
    row = conn.execute(
        "SELECT start_time, end_time, note FROM shifts WHERE user_id=? AND shift_date=?",
        (user["id"], today),
    ).fetchone()
    conn.close()
    return dict(row) if row else {}

@app.get("/api/shifts/mine")
def shift_mine(year: int = None, month: int = None, user=Depends(get_current_user)):
    today = date.today()
    y = year or today.year
    m = month or today.month
    conn = get_conn()
    rows = conn.execute(
        "SELECT shift_date, start_time, end_time, note FROM shifts WHERE user_id=? AND strftime('%Y-%m', shift_date)=? ORDER BY shift_date",
        (user["id"], f"{y:04d}-{m:02d}"),
    ).fetchall()
    conn.close()
    return {"shifts": [dict(r) for r in rows]}


# ── シフト（管理者） ──────────────────────────────────────────────────────────

class ShiftReq(BaseModel):
    employee_id: str
    shift_date: str
    start_time: str
    end_time: str
    note: Optional[str] = None

class TemplateReq(BaseModel):
    name: str
    start_time: str
    end_time: str

@app.get("/api/admin/shifts")
def admin_get_shifts(year: int = None, month: int = None, department_id: int = None, user=Depends(get_current_user)):
    require_admin(user)
    today = date.today()
    y = year or today.year
    m = month or today.month
    conn = get_conn()
    q = """
        SELECT s.id, s.user_id, u.name, u.employee_id, d.name as department,
               s.shift_date, s.start_time, s.end_time, s.note
        FROM shifts s
        JOIN users u ON s.user_id=u.id
        LEFT JOIN departments d ON u.department_id=d.id
        WHERE strftime('%Y-%m', s.shift_date)=?
    """
    params = [f"{y:04d}-{m:02d}"]
    if department_id:
        q += " AND u.department_id=?"
        params.append(department_id)
    q += " ORDER BY s.shift_date, d.name, u.employee_id"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return {"shifts": [dict(r) for r in rows]}

@app.post("/api/admin/shifts")
def admin_set_shift(req: ShiftReq, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    target = conn.execute("SELECT id FROM users WHERE employee_id=? AND is_active=1", (req.employee_id,)).fetchone()
    if not target:
        conn.close()
        raise HTTPException(status_code=404, detail="従業員が見つかりません。")
    conn.execute("""
        INSERT INTO shifts (user_id, shift_date, start_time, end_time, note, created_by)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(user_id, shift_date) DO UPDATE SET
            start_time=excluded.start_time, end_time=excluded.end_time,
            note=excluded.note, created_by=excluded.created_by
    """, (target["id"], req.shift_date, req.start_time, req.end_time, req.note, user["id"]))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.delete("/api/admin/shifts/{shift_id}")
def admin_delete_shift(shift_id: int, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    conn.execute("DELETE FROM shifts WHERE id=?", (shift_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.get("/api/admin/shift-templates")
def get_templates(user=Depends(get_current_user)):
    conn = get_conn()
    rows = conn.execute("SELECT * FROM shift_templates ORDER BY id").fetchall()
    conn.close()
    return {"templates": [dict(r) for r in rows]}

@app.post("/api/admin/shift-templates")
def create_template(req: TemplateReq, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    conn.execute("INSERT INTO shift_templates (name, start_time, end_time) VALUES (?,?,?)",
                 (req.name, req.start_time, req.end_time))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.delete("/api/admin/shift-templates/{tmpl_id}")
def delete_template(tmpl_id: int, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    conn.execute("DELETE FROM shift_templates WHERE id=?", (tmpl_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"status": "ok"}
