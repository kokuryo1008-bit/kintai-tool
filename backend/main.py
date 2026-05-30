"""勤怠管理ツール - バックエンド"""
import math
import sys
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware

sys.path.insert(0, str(Path(__file__).parent))
from auth import (create_token, get_current_user, hash_password,
                  require_admin, require_super_admin, verify_password)
from database import get_conn, init_db

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    _create_default_admin()
    yield


app = FastAPI(title="勤怠管理システム", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path.endswith(('.html', '.js', '.css')) or path in ('/', '/employee', '/admin'):
            response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            response.headers['Pragma'] = 'no-cache'
            response.headers['Expires'] = '0'
        return response

app.add_middleware(NoCacheMiddleware)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


def _create_default_admin():
    conn = get_conn()
    exists = conn.execute("SELECT 1 FROM users WHERE role='admin'").fetchone()
    if not exists:
        conn.execute(
            "INSERT INTO users (employee_id,name,role,password_hash,pin_hash,hire_date) VALUES (?,?,?,?,?,?)",
            ("admin", "管理者", "admin", hash_password("admin1234"), hash_password("0000"), datetime.now(JST).date().isoformat()),
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
    ci = datetime.strptime(f"{work_date} {row['clock_in']}", "%Y-%m-%d %H:%M:%S")
    co = datetime.strptime(f"{work_date} {row['clock_out']}", "%Y-%m-%d %H:%M:%S")
    if co < ci:
        co += timedelta(days=1)
    total_raw = int((co - ci).total_seconds() / 60)

    # 会社の休憩時間を取得して差し引く
    company = conn.execute("SELECT work_hours, break_minutes FROM company WHERE id=1").fetchone()
    break_min = int(company["break_minutes"] if company and company["break_minutes"] is not None else 60)
    total = max(0, total_raw - break_min)  # 実働時間

    # 部署の定時終了時刻を優先、なければ会社の所定労働時間で計算
    dept_row = conn.execute(
        "SELECT d.dept_work_end FROM users u LEFT JOIN departments d ON u.department_id=d.id WHERE u.id=?",
        (user_id,),
    ).fetchone()
    if dept_row and dept_row["dept_work_end"]:
        work_end = datetime.strptime(f"{work_date} {dept_row['dept_work_end']}", "%Y-%m-%d %H:%M")
        overtime_raw = max(0, int((co - work_end).total_seconds() / 60))
    else:
        std_min = int((company["work_hours"] if company else 8.0) * 60)
        overtime_raw = max(0, total - std_min)

    # 15分刻みで切り捨て
    overtime = (overtime_raw // 15) * 15
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
        "SELECT id, employee_id, name, role, password_hash, pin_hash, department_id FROM users WHERE employee_id=? AND is_active=1",
        (req.employee_id,),
    ).fetchone()
    conn.close()
    if not user:
        raise HTTPException(status_code=401, detail="社員IDまたはパスワードが違います。")
    ok = verify_password(req.password, user["password_hash"] or "") or verify_password(req.password, user["pin_hash"] or "")
    if not ok:
        raise HTTPException(status_code=401, detail="社員IDまたはパスワードが違います。")
    return {
        "token": create_token(user["id"], user["role"]),
        "role": user["role"],
        "name": user["name"],
        "employee_id": user["employee_id"],
        "department_id": user["department_id"],
    }


def _dept_id(user) -> Optional[int]:
    """manager は自部署のみ、admin は None（全部署）"""
    return user.get("department_id") if user["role"] == "manager" else None


# ── 会社設定 ──────────────────────────────────────────────────────────────────

class CompanySettingsReq(BaseModel):
    name: Optional[str] = None
    office_lat: Optional[float] = None
    office_lon: Optional[float] = None
    gps_radius: Optional[int] = None

class WorkSettingsReq(BaseModel):
    work_hours_per_day: Optional[float] = None
    default_leave_days: Optional[float] = None
    break_minutes: Optional[int] = None

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
        "break_minutes": d.get("break_minutes", 60),
    }

@app.put("/api/company/settings")
def update_company_settings(req: CompanySettingsReq, user=Depends(get_current_user)):
    require_super_admin(user)
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
    require_super_admin(user)
    conn = get_conn()
    conn.execute("""
        UPDATE company SET
            work_hours=COALESCE(?, work_hours),
            default_leave_days=COALESCE(?, default_leave_days),
            break_minutes=COALESCE(?, break_minutes),
            updated_at=datetime('now','localtime')
        WHERE id=1
    """, (req.work_hours_per_day, req.default_leave_days, req.break_minutes))
    conn.commit()
    conn.close()
    return {"ok": True}


# ── 部署 ──────────────────────────────────────────────────────────────────────

class DeptReq(BaseModel):
    name: str

@app.get("/api/departments")
def get_departments(user=Depends(get_current_user)):
    conn = get_conn()
    rows = conn.execute("SELECT id, name, weekly_off_days, dept_work_start, dept_work_end FROM departments ORDER BY id").fetchall()
    conn.close()
    return {"departments": [dict(r) for r in rows]}

class DeptWorkTimeReq(BaseModel):
    work_start: Optional[str] = None
    work_end: Optional[str] = None

@app.put("/api/departments/{dept_id}/work-time")
def update_dept_work_time(dept_id: int, req: DeptWorkTimeReq, user=Depends(get_current_user)):
    require_super_admin(user)
    conn = get_conn()
    conn.execute(
        "UPDATE departments SET dept_work_start=?, dept_work_end=? WHERE id=?",
        (req.work_start or None, req.work_end or None, dept_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}

@app.post("/api/departments")
def create_department(req: DeptReq, user=Depends(get_current_user)):
    require_super_admin(user)
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
    require_super_admin(user)
    conn = get_conn()
    conn.execute("DELETE FROM departments WHERE id=?", (dept_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

class DeptHolidayReq(BaseModel):
    weekly_off_days: str = ""

@app.put("/api/departments/{dept_id}/holidays")
def update_dept_holidays(dept_id: int, req: DeptHolidayReq, user=Depends(get_current_user)):
    require_admin(user)
    if user["role"] == "manager" and user.get("department_id") != dept_id:
        raise HTTPException(status_code=403, detail="自部署のみ設定できます。")
    conn = get_conn()
    conn.execute("UPDATE departments SET weekly_off_days=? WHERE id=?", (req.weekly_off_days, dept_id))
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
    today = datetime.now(JST).date().isoformat()
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
    now_jst = datetime.now(JST)
    today = now_jst.date().isoformat()
    now_time = now_jst.strftime("%H:%M:%S")
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
    now_jst = datetime.now(JST)
    today = now_jst.date().isoformat()
    now_time = now_jst.strftime("%H:%M:%S")
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
    today = datetime.now(JST).date()
    y = year or today.year
    m = month or today.month
    conn = get_conn()
    rows = conn.execute(
        "SELECT work_date as date, clock_in, clock_out, work_minutes, overtime_minutes FROM attendance WHERE user_id=? AND strftime('%Y-%m', work_date)=? ORDER BY work_date",
        (user["id"], f"{y:04d}-{m:02d}"),
    ).fetchall()
    conn.close()
    return {"records": [dict(r) for r in rows]}


# ── 勤怠修正（管理者） ───────────────────────────────────────────────────────

class AttEditReq(BaseModel):
    clock_in: str
    clock_out: Optional[str] = None

@app.put("/api/admin/attendance/{att_id}")
def admin_edit_attendance(att_id: int, req: AttEditReq, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    row = conn.execute(
        "SELECT a.user_id, a.work_date, u.department_id FROM attendance a JOIN users u ON a.user_id=u.id WHERE a.id=?",
        (att_id,),
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="記録が見つかりません。")
    if user["role"] == "manager" and user.get("department_id") != row["department_id"]:
        conn.close()
        raise HTTPException(status_code=403, detail="自部署のみ修正できます。")
    clock_in = req.clock_in or None
    clock_out = req.clock_out or None
    conn.execute(
        "UPDATE attendance SET clock_in=?, clock_out=? WHERE id=?",
        (clock_in, clock_out, att_id),
    )
    if clock_out:
        _calc_hours(conn, row["user_id"], row["work_date"])
    else:
        conn.execute("UPDATE attendance SET work_minutes=0, overtime_minutes=0 WHERE id=?", (att_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


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
    today = datetime.now(JST).date().isoformat()
    dept = _dept_id(user)
    conn = get_conn()
    dept_cond = "AND u.department_id=?" if dept else ""
    dept_p = (dept,) if dept else ()
    total = conn.execute(f"SELECT COUNT(*) FROM users u WHERE u.is_active=1 AND u.role NOT IN ('admin') {dept_cond}", dept_p).fetchone()[0]
    present = conn.execute(
        f"SELECT COUNT(*) FROM attendance a JOIN users u ON a.user_id=u.id WHERE a.work_date=? AND a.clock_in IS NOT NULL AND u.is_active=1 AND u.role NOT IN ('admin') {dept_cond}",
        (today,) + dept_p,
    ).fetchone()[0]
    p_leave = conn.execute(
        f"SELECT COUNT(*) FROM leave_requests lr JOIN users u ON lr.user_id=u.id WHERE lr.status='pending' {dept_cond}", dept_p
    ).fetchone()[0]
    p_trip = conn.execute(
        f"SELECT COUNT(*) FROM business_trips bt JOIN users u ON bt.user_id=u.id WHERE bt.status='pending' {dept_cond}", dept_p
    ).fetchone()[0]
    conn.close()
    return {"total_employees": total, "today_present": present, "pending_leave": p_leave, "pending_trip": p_trip}

@app.get("/api/admin/today")
def admin_today(user=Depends(get_current_user)):
    require_admin(user)
    today = datetime.now(JST).date().isoformat()
    dept = _dept_id(user)
    conn = get_conn()
    q = """
        SELECT u.name, d.name as department, a.clock_in, a.clock_out
        FROM users u
        LEFT JOIN departments d ON u.department_id=d.id
        LEFT JOIN attendance a ON a.user_id=u.id AND a.work_date=?
        WHERE u.is_active=1 AND u.role NOT IN ('admin')
    """
    params = [today]
    if dept:
        q += " AND u.department_id=?"
        params.append(dept)
    q += " ORDER BY d.name, u.employee_id"
    rows = conn.execute(q, params).fetchall()
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
def admin_list_employees(department_id: int = None, user=Depends(get_current_user)):
    require_admin(user)
    dept = _dept_id(user) or department_id
    conn = get_conn()
    q = """
        SELECT u.employee_id, u.name, u.department_id, d.name as department, u.position,
               u.role, (u.annual_leave - COALESCE(u.used_leave,0)) as leave_remaining
        FROM users u LEFT JOIN departments d ON u.department_id=d.id
        WHERE u.is_active=1 AND u.role NOT IN ('admin')
    """
    params = []
    if dept:
        q += " AND u.department_id=?"
        params.append(dept)
    q += " ORDER BY d.name, u.employee_id"
    rows = conn.execute(q, params).fetchall()
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
    # manager は自部署のみに登録可能
    dept = _dept_id(user)
    dept_id = dept if dept else req.department_id
    # manager が admin を作れないよう制限
    role = req.role if user["role"] == "admin" else ("employee" if req.role not in ("employee","manager") else req.role)
    pw_hash = hash_password(req.password) if req.password else hash_password("password")
    conn = get_conn()
    try:
        conn.execute("""
            INSERT INTO users (employee_id, name, role, department_id, position, password_hash, pin_hash, annual_leave, hire_date)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (req.employee_id.strip(), req.name.strip(), role, dept_id,
              req.position, pw_hash, pw_hash, req.leave_remaining, datetime.now(JST).date().isoformat()))
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

@app.get("/api/admin/employees/{emp_id}/monthly-summary")
def emp_monthly_summary(emp_id: str, year: int = None, month: int = None, user=Depends(get_current_user)):
    require_admin(user)
    today = datetime.now(JST).date()
    y = year or today.year
    m = month or today.month
    conn = get_conn()
    emp = conn.execute(
        "SELECT u.id, u.name, u.employee_id, d.name as department, u.position, u.role, (u.annual_leave - COALESCE(u.used_leave,0)) as leave_remaining FROM users u LEFT JOIN departments d ON u.department_id=d.id WHERE u.employee_id=? AND u.is_active=1",
        (emp_id,)
    ).fetchone()
    if not emp:
        conn.close()
        raise HTTPException(status_code=404, detail="従業員が見つかりません。")
    rows = conn.execute(
        "SELECT a.id, a.work_date as date, a.clock_in, a.clock_out, a.work_minutes, a.overtime_minutes FROM attendance a WHERE a.user_id=? AND strftime('%Y-%m', a.work_date)=? ORDER BY a.work_date",
        (emp["id"], f"{y:04d}-{m:02d}")
    ).fetchall()
    records = [dict(r) for r in rows]
    work_days     = sum(1 for r in records if r["clock_in"])
    total_work    = sum(r["work_minutes"] or 0 for r in records)
    total_overtime = sum(r["overtime_minutes"] or 0 for r in records)
    conn.close()
    return {
        "employee": dict(emp),
        "year": y, "month": m,
        "work_days": work_days,
        "total_work_minutes": total_work,
        "total_overtime_minutes": total_overtime,
        "records": records,
    }

@app.get("/api/admin/attendance")
def admin_attendance(year: int = None, month: int = None, department_id: int = None, employee_id: str = None, user=Depends(get_current_user)):
    require_admin(user)
    today = datetime.now(JST).date()
    y = year or today.year
    m = month or today.month
    dept = _dept_id(user) or department_id
    conn = get_conn()
    q = """
        SELECT a.id, a.work_date as date, u.name, d.name as department,
               a.clock_in, a.clock_out, a.work_minutes, a.overtime_minutes
        FROM attendance a
        JOIN users u ON a.user_id=u.id
        LEFT JOIN departments d ON u.department_id=d.id
        WHERE strftime('%Y-%m', a.work_date)=?
    """
    params = [f"{y:04d}-{m:02d}"]
    if dept:
        q += " AND u.department_id=?"
        params.append(dept)
    q += " ORDER BY a.work_date DESC, d.name, u.employee_id"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return {"records": [dict(r) for r in rows]}


# ── 有給申請管理（管理者） ────────────────────────────────────────────────────

@app.get("/api/admin/leave")
def admin_leave_list(status: str = "", user=Depends(get_current_user)):
    require_admin(user)
    dept = _dept_id(user)
    conn = get_conn()
    conditions = []
    params = []
    if status:
        conditions.append("lr.status=?")
        params.append(status)
    if dept:
        conditions.append("u.department_id=?")
        params.append(dept)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    q = f"""
        SELECT lr.id, u.name, d.name as department,
               lr.start_date, lr.end_date, lr.days, lr.reason, lr.status, lr.created_at
        FROM leave_requests lr
        JOIN users u ON lr.user_id=u.id
        LEFT JOIN departments d ON u.department_id=d.id
        {where} ORDER BY lr.created_at DESC
    """
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
    dept = _dept_id(user)
    conn = get_conn()
    conditions = []
    params = []
    if status:
        conditions.append("bt.status=?")
        params.append(status)
    if dept:
        conditions.append("u.department_id=?")
        params.append(dept)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    q = f"""
        SELECT bt.id, u.name, d.name as department,
               bt.trip_date, bt.destination, bt.reason, bt.status, bt.created_at
        FROM business_trips bt
        JOIN users u ON bt.user_id=u.id
        LEFT JOIN departments d ON u.department_id=d.id
        {where} ORDER BY bt.created_at DESC
    """
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
    today = datetime.now(JST).date().isoformat()
    conn = get_conn()
    row = conn.execute(
        "SELECT start_time, end_time, note FROM shifts WHERE user_id=? AND shift_date=?",
        (user["id"], today),
    ).fetchone()
    conn.close()
    return dict(row) if row else {}

@app.get("/api/shifts/mine")
def shift_mine(year: int = None, month: int = None, user=Depends(get_current_user)):
    today = datetime.now(JST).date()
    y = year or today.year
    m = month or today.month
    conn = get_conn()
    rows = conn.execute(
        "SELECT shift_date, start_time, end_time, note FROM shifts WHERE user_id=? AND strftime('%Y-%m', shift_date)=? ORDER BY shift_date",
        (user["id"], f"{y:04d}-{m:02d}"),
    ).fetchall()
    conn.close()
    return {"shifts": [dict(r) for r in rows]}


@app.get("/api/shifts")
def get_shifts_all(year: int = None, month: int = None, user=Depends(get_current_user)):
    today = datetime.now(JST).date()
    y = year or today.year
    m = month or today.month
    conn = get_conn()
    rows = conn.execute("""
        SELECT u.name, u.employee_id, d.name as department,
               s.shift_date, s.start_time, s.end_time, s.note
        FROM shifts s
        JOIN users u ON s.user_id=u.id
        LEFT JOIN departments d ON u.department_id=d.id
        WHERE strftime('%Y-%m', s.shift_date)=?
        ORDER BY s.shift_date, d.name, u.employee_id
    """, [f"{y:04d}-{m:02d}"]).fetchall()
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
    today = datetime.now(JST).date()
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

class ShiftBulkReq(BaseModel):
    employee_id: str
    dates: list[str]
    start_time: str
    end_time: str

@app.post("/api/admin/shifts/bulk")
def admin_set_shifts_bulk(req: ShiftBulkReq, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    target = conn.execute("SELECT id, department_id FROM users WHERE employee_id=? AND is_active=1", (req.employee_id,)).fetchone()
    if not target:
        conn.close()
        raise HTTPException(status_code=404, detail="従業員が見つかりません。")
    if user["role"] == "manager" and user.get("department_id") != target["department_id"]:
        conn.close()
        raise HTTPException(status_code=403, detail="自部署の従業員のみシフト設定できます。")
    for d in req.dates:
        conn.execute("""
            INSERT INTO shifts (user_id, shift_date, start_time, end_time, created_by)
            VALUES (?,?,?,?,?)
            ON CONFLICT(user_id, shift_date) DO UPDATE SET
                start_time=excluded.start_time, end_time=excluded.end_time, created_by=excluded.created_by
        """, (target["id"], d, req.start_time, req.end_time, user["id"]))
    conn.commit()
    conn.close()
    return {"ok": True, "count": len(req.dates)}


@app.post("/api/admin/shifts")
def admin_set_shift(req: ShiftReq, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    target = conn.execute("SELECT id, department_id FROM users WHERE employee_id=? AND is_active=1", (req.employee_id,)).fetchone()
    if not target:
        conn.close()
        raise HTTPException(status_code=404, detail="従業員が見つかりません。")
    if user["role"] == "manager" and user.get("department_id") != target["department_id"]:
        conn.close()
        raise HTTPException(status_code=403, detail="自部署の従業員のみシフト設定できます。")
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


@app.get("/api/admin/shifts/annual")
def admin_get_annual_shifts(year: int = None, department_id: int = None, user=Depends(get_current_user)):
    require_admin(user)
    y = year or datetime.now(JST).date().year
    dept = _dept_id(user) or department_id
    conn = get_conn()
    q = """
        SELECT s.id, u.name, u.employee_id, d.name as department,
               s.shift_date, s.start_time, s.end_time
        FROM shifts s
        JOIN users u ON s.user_id=u.id
        LEFT JOIN departments d ON u.department_id=d.id
        WHERE strftime('%Y', s.shift_date)=?
    """
    params = [f"{y:04d}"]
    if dept:
        q += " AND u.department_id=?"
        params.append(dept)
    q += " ORDER BY s.shift_date, u.employee_id"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return {"shifts": [dict(r) for r in rows]}


# ── 年度カレンダー・祝日管理 ───────────────────────────────────────────────────

def _jp_holidays(year: int) -> dict:
    """日本の国民の祝日 {date_str: name}"""
    h: dict = {}

    def add(mo: int, d: int, name: str):
        try:
            h[date(year, mo, d).isoformat()] = name
        except ValueError:
            pass

    def nth_monday(mo: int, n: int) -> date:
        first = date(year, mo, 1)
        offset = (0 - first.weekday()) % 7
        return first + timedelta(days=offset + 7 * (n - 1))

    add(1, 1, "元日")
    add(2, 11, "建国記念の日")
    if year >= 2020:
        add(2, 23, "天皇誕生日")
    else:
        add(12, 23, "天皇誕生日")
    add(4, 29, "昭和の日")
    add(5, 3, "憲法記念日")
    add(5, 4, "みどりの日")
    add(5, 5, "こどもの日")
    if year >= 2016:
        add(8, 11, "山の日")
    add(11, 3, "文化の日")
    add(11, 23, "勤労感謝の日")

    nm = nth_monday(1, 2);  add(nm.month, nm.day, "成人の日")
    nm = nth_monday(7, 3);  add(nm.month, nm.day, "海の日")
    nm = nth_monday(9, 3);  add(nm.month, nm.day, "敬老の日")
    if year >= 2020:
        nm = nth_monday(10, 2); add(nm.month, nm.day, "スポーツの日")
    else:
        nm = nth_monday(10, 2); add(nm.month, nm.day, "体育の日")

    if 1980 <= year <= 2099:
        shunbun = int(20.8431 + 0.242194 * (year - 1980) - int((year - 1980) / 4))
        shubun  = int(23.2488 + 0.242194 * (year - 1980) - int((year - 1980) / 4))
        add(3, shunbun, "春分の日")
        add(9, shubun,  "秋分の日")

    subs: dict = {}
    for ds in sorted(h):
        d_obj = date.fromisoformat(ds)
        if d_obj.weekday() == 6:  # 日曜
            nxt = d_obj + timedelta(days=1)
            while nxt.isoformat() in h or nxt.isoformat() in subs:
                nxt += timedelta(days=1)
            subs[nxt.isoformat()] = "振替休日"
    h.update(subs)

    all_h = set(h)
    for ds in list(all_h):
        d_obj = date.fromisoformat(ds)
        prev2 = (d_obj - timedelta(days=2)).isoformat()
        mid   = (d_obj - timedelta(days=1)).isoformat()
        if prev2 in all_h and mid not in all_h:
            mid_obj = date.fromisoformat(mid)
            if mid_obj.weekday() != 6:
                h[mid] = "国民の休日"

    return h


class HolidayReq(BaseModel):
    holiday_date: str
    name: str

class HolidayImportReq(BaseModel):
    fiscal_year: int

class MandatoryLeaveReq(BaseModel):
    employee_id: str
    fiscal_year: int
    dates: list[str]

class MandatoryLeaveBulkReq(BaseModel):
    department_id: int
    fiscal_year: int
    dates: list[str]


@app.get("/api/admin/holidays")
def get_holidays(fiscal_year: int = None, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    if fiscal_year:
        rows = conn.execute(
            "SELECT id, holiday_date, name FROM holidays WHERE holiday_date BETWEEN ? AND ? ORDER BY holiday_date",
            (f"{fiscal_year}-04-01", f"{fiscal_year+1}-03-31"),
        ).fetchall()
    else:
        rows = conn.execute("SELECT id, holiday_date, name FROM holidays ORDER BY holiday_date").fetchall()
    conn.close()
    return {"holidays": [dict(r) for r in rows]}


@app.post("/api/admin/holidays")
def add_holiday(req: HolidayReq, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO holidays (holiday_date, name) VALUES (?,?) ON CONFLICT(holiday_date) DO NOTHING",
            (req.holiday_date, req.name),
        )
        conn.commit()
    except Exception:
        try: conn.rollback()
        except Exception: pass
        raise HTTPException(400, "登録に失敗しました")
    conn.close()
    return {"ok": True}


@app.delete("/api/admin/holidays/{holiday_id}")
def delete_holiday(holiday_id: int, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    conn.execute("DELETE FROM holidays WHERE id=?", (holiday_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/admin/holidays/import")
def import_holidays(req: HolidayImportReq, user=Depends(get_current_user)):
    require_admin(user)
    fy = req.fiscal_year
    all_hols = {**_jp_holidays(fy), **_jp_holidays(fy + 1)}
    start, end = f"{fy}-04-01", f"{fy+1}-03-31"
    filtered = {k: v for k, v in all_hols.items() if start <= k <= end}
    conn = get_conn()
    for date_str, name in filtered.items():
        try:
            conn.execute(
                "INSERT INTO holidays (holiday_date, name) VALUES (?,?) ON CONFLICT(holiday_date) DO NOTHING",
                (date_str, name),
            )
        except Exception:
            pass
    conn.commit()
    conn.close()
    return {"ok": True, "count": len(filtered), "holidays": filtered}


@app.get("/api/admin/calendar/annual")
def admin_annual_calendar(fiscal_year: int = None, department_id: int = None, user=Depends(get_current_user)):
    require_admin(user)
    now_jst = datetime.now(JST)
    fy = fiscal_year or (now_jst.year if now_jst.month >= 4 else now_jst.year - 1)
    dept = _dept_id(user) or department_id
    start_date, end_date = f"{fy}-04-01", f"{fy+1}-03-31"
    conn = get_conn()

    hol_rows = conn.execute(
        "SELECT id, holiday_date, name FROM holidays WHERE holiday_date BETWEEN ? AND ? ORDER BY holiday_date",
        (start_date, end_date),
    ).fetchall()
    national_holidays = {r["holiday_date"]: {"id": r["id"], "name": r["name"]} for r in hol_rows}

    dept_off: set = set()
    if dept:
        dr = conn.execute("SELECT weekly_off_days FROM departments WHERE id=?", (dept,)).fetchone()
        if dr and dr["weekly_off_days"]:
            dept_off = {int(x) for x in dr["weekly_off_days"].split(",") if x.strip()}

    q = """
        SELECT s.id, s.shift_date, s.start_time, s.end_time,
               u.employee_id, u.name, d.name as department
        FROM shifts s JOIN users u ON s.user_id=u.id
        LEFT JOIN departments d ON u.department_id=d.id
        WHERE s.shift_date BETWEEN ? AND ?
    """
    params: list = [start_date, end_date]
    if dept:
        q += " AND u.department_id=?"
        params.append(dept)
    shift_rows = conn.execute(q, params).fetchall()
    shift_map: dict = {}
    for s in shift_rows:
        sd = s["shift_date"]
        if sd not in shift_map:
            shift_map[sd] = []
        shift_map[sd].append(dict(s))

    ml_q = """
        SELECT u.employee_id, ml.leave_date
        FROM mandatory_leaves ml JOIN users u ON ml.user_id=u.id
        WHERE ml.fiscal_year=?
    """
    ml_p: list = [fy]
    if dept:
        ml_q += " AND u.department_id=?"
        ml_p.append(dept)
    ml_rows = conn.execute(ml_q, ml_p).fetchall()
    mandatory_map: dict = {}
    for r in ml_rows:
        ds = r["leave_date"]
        if ds not in mandatory_map:
            mandatory_map[ds] = []
        mandatory_map[ds].append(r["employee_id"])

    months = []
    total_work = total_hol = 0
    for i in range(12):
        mo = 4 + i if 4 + i <= 12 else 4 + i - 12
        yr = fy if mo >= 4 else fy + 1
        days_in_mo = (date(yr, mo % 12 + 1, 1) - timedelta(days=1)).day if mo < 12 else 31
        work = hol = 0
        for d_num in range(1, days_in_mo + 1):
            ds = f"{yr}-{mo:02d}-{d_num:02d}"
            dow_js = (date(yr, mo, d_num).weekday() + 1) % 7  # 0=Sun,6=Sat
            if dow_js in {0, 6} or dow_js in dept_off or ds in national_holidays:
                hol += 1
            else:
                work += 1
        total_work += work
        total_hol += hol
        months.append({"year": yr, "month": mo, "work_days": work, "holiday_days": hol})

    conn.close()
    return {
        "fiscal_year": fy,
        "national_holidays": national_holidays,
        "dept_off_days": list(dept_off),
        "shift_map": shift_map,
        "mandatory_map": mandatory_map,
        "months": months,
        "total_work_days": total_work,
        "total_holiday_days": total_hol,
    }


@app.get("/api/admin/mandatory-leaves")
def get_mandatory_leaves(fiscal_year: int, employee_id: str = None, user=Depends(get_current_user)):
    require_admin(user)
    dept = _dept_id(user)
    conn = get_conn()
    q = """
        SELECT u.employee_id, u.name, ml.leave_date
        FROM mandatory_leaves ml JOIN users u ON ml.user_id=u.id
        WHERE ml.fiscal_year=?
    """
    params: list = [fiscal_year]
    if employee_id:
        q += " AND u.employee_id=?"
        params.append(employee_id)
    if dept:
        q += " AND u.department_id=?"
        params.append(dept)
    rows = conn.execute(q, params).fetchall()
    conn.close()
    result: dict = {}
    for r in rows:
        eid = r["employee_id"]
        if eid not in result:
            result[eid] = {"name": r["name"], "dates": []}
        result[eid]["dates"].append(r["leave_date"])
    return {"mandatory_leaves": result}


@app.post("/api/admin/mandatory-leaves")
def set_mandatory_leaves(req: MandatoryLeaveReq, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    target = conn.execute(
        "SELECT id, department_id FROM users WHERE employee_id=? AND is_active=1", (req.employee_id,)
    ).fetchone()
    if not target:
        raise HTTPException(404, "従業員が見つかりません")
    if user["role"] == "manager" and user.get("department_id") != target["department_id"]:
        raise HTTPException(403, "自部署のみ設定できます")
    conn.execute(
        "DELETE FROM mandatory_leaves WHERE user_id=? AND fiscal_year=?",
        (target["id"], req.fiscal_year),
    )
    for d in req.dates:
        conn.execute(
            "INSERT INTO mandatory_leaves (user_id, fiscal_year, leave_date) VALUES (?,?,?)",
            (target["id"], req.fiscal_year, d),
        )
    conn.commit()
    conn.close()
    return {"ok": True, "count": len(req.dates)}


@app.post("/api/admin/mandatory-leaves/bulk")
def set_mandatory_leaves_bulk(req: MandatoryLeaveBulkReq, user=Depends(get_current_user)):
    require_admin(user)
    if user["role"] == "manager" and user.get("department_id") != req.department_id:
        raise HTTPException(403, "自部署のみ設定できます")
    conn = get_conn()
    employees = conn.execute(
        "SELECT id FROM users WHERE department_id=? AND is_active=1",
        (req.department_id,),
    ).fetchall()
    for emp in employees:
        conn.execute(
            "DELETE FROM mandatory_leaves WHERE user_id=? AND fiscal_year=?",
            (emp["id"], req.fiscal_year),
        )
        for d in req.dates:
            conn.execute(
                "INSERT INTO mandatory_leaves (user_id, fiscal_year, leave_date) VALUES (?,?,?)",
                (emp["id"], req.fiscal_year, d),
            )
    conn.commit()
    conn.close()
    return {"ok": True, "employee_count": len(employees), "date_count": len(req.dates)}


# ── 日報（従業員） ────────────────────────────────────────────────────────────

class DailyReportReq(BaseModel):
    report_date: str
    part_number: Optional[str] = None
    estimate_no: Optional[str] = None
    work_code: Optional[str] = None
    board_start: Optional[str] = None
    board_end: Optional[str] = None
    other_code: Optional[str] = None
    other_start: Optional[str] = None
    other_end: Optional[str] = None

@app.get("/api/reports/mine")
def get_my_reports(year: int = None, month: int = None, user=Depends(get_current_user)):
    today = datetime.now(JST).date()
    y = year or today.year
    m = month or today.month
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, report_date, part_number, estimate_no, work_code, board_start, board_end, other_code, other_start, other_end FROM daily_reports WHERE user_id=? AND strftime('%Y-%m', report_date)=? ORDER BY report_date, id",
        (user["id"], f"{y:04d}-{m:02d}"),
    ).fetchall()
    conn.close()
    return {"entries": [dict(r) for r in rows]}

@app.post("/api/reports")
def create_report(req: DailyReportReq, user=Depends(get_current_user)):
    conn = get_conn()
    conn.execute(
        "INSERT INTO daily_reports (user_id, report_date, part_number, estimate_no, work_code, board_start, board_end, other_code, other_start, other_end) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (user["id"], req.report_date, req.part_number or None, req.estimate_no or None,
         req.work_code or None, req.board_start or None, req.board_end or None,
         req.other_code or None, req.other_start or None, req.other_end or None),
    )
    conn.commit()
    conn.close()
    return {"ok": True}

@app.put("/api/reports/{entry_id}")
def update_report(entry_id: int, req: DailyReportReq, user=Depends(get_current_user)):
    conn = get_conn()
    row = conn.execute("SELECT user_id FROM daily_reports WHERE id=?", (entry_id,)).fetchone()
    if not row or row["user_id"] != user["id"]:
        conn.close()
        raise HTTPException(status_code=404, detail="記録が見つかりません。")
    conn.execute(
        "UPDATE daily_reports SET report_date=?, part_number=?, estimate_no=?, work_code=?, board_start=?, board_end=?, other_code=?, other_start=?, other_end=? WHERE id=?",
        (req.report_date, req.part_number or None, req.estimate_no or None,
         req.work_code or None, req.board_start or None, req.board_end or None,
         req.other_code or None, req.other_start or None, req.other_end or None, entry_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}

@app.delete("/api/reports/{entry_id}")
def delete_report(entry_id: int, user=Depends(get_current_user)):
    conn = get_conn()
    row = conn.execute("SELECT user_id FROM daily_reports WHERE id=?", (entry_id,)).fetchone()
    if not row or row["user_id"] != user["id"]:
        conn.close()
        raise HTTPException(status_code=404, detail="記録が見つかりません。")
    conn.execute("DELETE FROM daily_reports WHERE id=?", (entry_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ── 日報（管理者） ────────────────────────────────────────────────────────────

@app.get("/api/admin/reports")
def admin_get_reports(year: int = None, month: int = None, employee_id: str = None, department_id: int = None, user=Depends(get_current_user)):
    require_admin(user)
    today = datetime.now(JST).date()
    y = year or today.year
    m = month or today.month
    dept = _dept_id(user) or department_id
    conn = get_conn()
    q = """
        SELECT dr.id, dr.report_date, u.name, u.employee_id, d.name as department,
               dr.part_number, dr.estimate_no, dr.work_code, dr.board_start, dr.board_end,
               dr.other_code, dr.other_start, dr.other_end
        FROM daily_reports dr
        JOIN users u ON dr.user_id=u.id
        LEFT JOIN departments d ON u.department_id=d.id
        WHERE strftime('%Y-%m', dr.report_date)=?
    """
    params = [f"{y:04d}-{m:02d}"]
    if employee_id:
        q += " AND u.employee_id=?"
        params.append(employee_id)
    if dept:
        q += " AND u.department_id=?"
        params.append(dept)
    q += " ORDER BY dr.report_date, u.employee_id, dr.id"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return {"entries": [dict(r) for r in rows]}


# ── 営業報告（従業員） ──────────────────────────────────────────────────────────

class SalesReportReq(BaseModel):
    report_date: str
    client_company: str
    client_dept: Optional[str] = None
    client_name: Optional[str] = None
    purpose: Optional[str] = None
    content: Optional[str] = None
    amount: Optional[int] = None
    status: Optional[str] = None
    next_action: Optional[str] = None
    next_date: Optional[str] = None

@app.get("/api/sales/mine")
def get_my_sales(year: int = None, month: int = None, user=Depends(get_current_user)):
    today = datetime.now(JST).date()
    y = year or today.year
    m = month or today.month
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, report_date, client_company, client_dept, client_name, purpose, content, amount, status, next_action, next_date FROM sales_reports WHERE user_id=? AND strftime('%Y-%m', report_date)=? ORDER BY report_date DESC, id DESC",
        (user["id"], f"{y:04d}-{m:02d}"),
    ).fetchall()
    conn.close()
    return {"entries": [dict(r) for r in rows]}

@app.post("/api/sales")
def create_sales(req: SalesReportReq, user=Depends(get_current_user)):
    if not req.client_company.strip():
        raise HTTPException(status_code=400, detail="会社名を入力してください。")
    conn = get_conn()
    conn.execute(
        "INSERT INTO sales_reports (user_id, report_date, client_company, client_dept, client_name, purpose, content, amount, status, next_action, next_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (user["id"], req.report_date, req.client_company.strip(), req.client_dept or None,
         req.client_name or None, req.purpose or None, req.content or None,
         req.amount, req.status or None, req.next_action or None, req.next_date or None),
    )
    conn.commit()
    conn.close()
    return {"ok": True}

@app.put("/api/sales/{report_id}")
def update_sales(report_id: int, req: SalesReportReq, user=Depends(get_current_user)):
    conn = get_conn()
    row = conn.execute("SELECT user_id FROM sales_reports WHERE id=?", (report_id,)).fetchone()
    if not row or row["user_id"] != user["id"]:
        conn.close()
        raise HTTPException(status_code=404, detail="記録が見つかりません。")
    conn.execute(
        "UPDATE sales_reports SET report_date=?, client_company=?, client_dept=?, client_name=?, purpose=?, content=?, amount=?, status=?, next_action=?, next_date=? WHERE id=?",
        (req.report_date, req.client_company.strip(), req.client_dept or None,
         req.client_name or None, req.purpose or None, req.content or None,
         req.amount, req.status or None, req.next_action or None, req.next_date or None, report_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}

@app.delete("/api/sales/{report_id}")
def delete_sales(report_id: int, user=Depends(get_current_user)):
    conn = get_conn()
    row = conn.execute("SELECT user_id FROM sales_reports WHERE id=?", (report_id,)).fetchone()
    if not row or row["user_id"] != user["id"]:
        conn.close()
        raise HTTPException(status_code=404, detail="記録が見つかりません。")
    conn.execute("DELETE FROM sales_reports WHERE id=?", (report_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ── 営業報告（管理者） ──────────────────────────────────────────────────────────

@app.get("/api/admin/sales")
def admin_get_sales(year: int = None, month: int = None, employee_id: str = None, department_id: int = None, status: str = None, user=Depends(get_current_user)):
    require_admin(user)
    today = datetime.now(JST).date()
    y = year or today.year
    m = month or today.month
    dept = _dept_id(user) or department_id
    conn = get_conn()
    q = """
        SELECT sr.id, sr.report_date, u.name, u.employee_id, d.name as department,
               sr.client_company, sr.client_dept, sr.client_name, sr.purpose,
               sr.content, sr.amount, sr.status, sr.next_action, sr.next_date
        FROM sales_reports sr
        JOIN users u ON sr.user_id=u.id
        LEFT JOIN departments d ON u.department_id=d.id
        WHERE strftime('%Y-%m', sr.report_date)=?
    """
    params = [f"{y:04d}-{m:02d}"]
    if employee_id:
        q += " AND u.employee_id=?"
        params.append(employee_id)
    if dept:
        q += " AND u.department_id=?"
        params.append(dept)
    if status:
        q += " AND sr.status=?"
        params.append(status)
    q += " ORDER BY sr.report_date DESC, u.employee_id, sr.id DESC"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return {"entries": [dict(r) for r in rows]}


# ── 残業申請 ─────────────────────────────────────────────────────────────────

class OvertimeReq(BaseModel):
    employee_id: str
    work_date: str
    planned_end: Optional[str] = None
    reason: Optional[str] = None

@app.get("/api/overtime/mine")
def get_my_overtime(year: int = None, month: int = None, user=Depends(get_current_user)):
    today = datetime.now(JST).date()
    y = year or today.year
    m = month or today.month
    conn = get_conn()
    rows = conn.execute(
        """SELECT o.id, o.work_date, o.planned_end, o.reason, o.status, o.created_at,
                  a.clock_in, a.clock_out, a.overtime_minutes
           FROM overtime_requests o
           LEFT JOIN attendance a ON a.user_id=o.user_id AND a.work_date=o.work_date
           WHERE o.user_id=? AND strftime('%Y-%m', o.work_date)=?
           ORDER BY o.work_date DESC""",
        (user["id"], f"{y:04d}-{m:02d}"),
    ).fetchall()
    conn.close()
    return {"entries": [dict(r) for r in rows]}

@app.post("/api/overtime")
def create_overtime(req: OvertimeReq, user=Depends(get_current_user)):
    require_admin(user)  # 管理職以上のみ申請可能
    conn = get_conn()
    emp = conn.execute(
        "SELECT id, department_id FROM users WHERE employee_id=? AND is_active=1", (req.employee_id,)
    ).fetchone()
    if not emp:
        conn.close()
        raise HTTPException(404, "従業員が見つかりません。")
    if user["role"] == "manager" and user.get("department_id") != emp["department_id"]:
        conn.close()
        raise HTTPException(403, "自部署の従業員のみ申請できます。")
    try:
        conn.execute(
            "INSERT INTO overtime_requests (user_id, work_date, planned_end, reason) VALUES (?,?,?,?)",
            (emp["id"], req.work_date, req.planned_end or None, req.reason or None),
        )
        conn.commit()
    except Exception:
        try: conn.rollback()
        except Exception: pass
        raise HTTPException(400, "同じ日付の申請が既にあります。")
    conn.close()
    return {"ok": True}

@app.delete("/api/overtime/{req_id}")
def delete_overtime(req_id: int, user=Depends(get_current_user)):
    require_admin(user)
    conn = get_conn()
    row = conn.execute(
        """SELECT o.id, o.status, u.department_id FROM overtime_requests o
           JOIN users u ON o.user_id=u.id WHERE o.id=?""", (req_id,)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "申請が見つかりません。")
    if user["role"] == "manager" and user.get("department_id") != row["department_id"]:
        conn.close()
        raise HTTPException(403, "自部署の申請のみ取り消せます。")
    if row["status"] != "pending":
        conn.close()
        raise HTTPException(400, "承認済み・却下済みの申請は取り消せません。")
    conn.execute("DELETE FROM overtime_requests WHERE id=?", (req_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ── 残業申請（管理者） ────────────────────────────────────────────────────────

@app.get("/api/admin/overtime")
def admin_overtime_list(year: int = None, month: int = None, status: str = "", department_id: int = None, user=Depends(get_current_user)):
    require_admin(user)
    today = datetime.now(JST).date()
    y = year or today.year
    m = month or today.month
    dept = _dept_id(user) or department_id
    conn = get_conn()
    conditions = ["strftime('%Y-%m', o.work_date)=?"]
    params: list = [f"{y:04d}-{m:02d}"]
    if status:
        conditions.append("o.status=?")
        params.append(status)
    if dept:
        conditions.append("u.department_id=?")
        params.append(dept)
    where = "WHERE " + " AND ".join(conditions)
    q = f"""
        SELECT o.id, o.work_date, o.planned_end, o.reason, o.status, o.created_at,
               u.name, u.employee_id, d.name as department,
               a.clock_in, a.clock_out, a.overtime_minutes
        FROM overtime_requests o
        JOIN users u ON o.user_id=u.id
        LEFT JOIN departments d ON u.department_id=d.id
        LEFT JOIN attendance a ON a.user_id=o.user_id AND a.work_date=o.work_date
        {where}
        ORDER BY o.work_date DESC, d.name, u.employee_id
    """
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return {"entries": [dict(r) for r in rows]}

@app.post("/api/admin/overtime/{req_id}/approve")
def admin_approve_overtime(req_id: int, user=Depends(get_current_user)):
    require_super_admin(user)  # 総務部（super_admin）のみ承認可
    conn = get_conn()
    row = conn.execute("SELECT id FROM overtime_requests WHERE id=? AND status='pending'", (req_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "申請が見つかりません。")
    conn.execute(
        "UPDATE overtime_requests SET status='approved', approved_by=?, approved_at=datetime('now','localtime') WHERE id=?",
        (user["id"], req_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}

@app.post("/api/admin/overtime/{req_id}/reject")
def admin_reject_overtime(req_id: int, user=Depends(get_current_user)):
    require_super_admin(user)  # 総務部（super_admin）のみ却下可
    conn = get_conn()
    row = conn.execute("SELECT id FROM overtime_requests WHERE id=? AND status='pending'", (req_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "申請が見つかりません。")
    conn.execute(
        "UPDATE overtime_requests SET status='rejected', approved_by=?, approved_at=datetime('now','localtime') WHERE id=?",
        (user["id"], req_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"status": "ok"}
