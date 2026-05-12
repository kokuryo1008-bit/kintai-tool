"""認証ユーティリティ（JWT + パスワードハッシュ）"""
import os
import hashlib
import hmac
import jwt
from datetime import datetime, timedelta
from fastapi import HTTPException, Header
from database import get_conn

SECRET = os.getenv("JWT_SECRET", "kintai-secret-change-in-production")
ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = 24


def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def verify_password(password: str, hashed: str) -> bool:
    return hmac.compare_digest(hash_password(password), hashed)


def create_token(user_id: int, role: str) -> str:
    payload = {
        "sub": str(user_id),
        "role": role,
        "exp": datetime.utcnow() + timedelta(hours=TOKEN_EXPIRE_HOURS),
    }
    return jwt.encode(payload, SECRET, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="トークンの有効期限切れです。再ログインしてください。")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="認証情報が無効です。")


def get_current_user(authorization: str = Header(...)):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="認証が必要です。")
    token = authorization[7:]
    payload = decode_token(token)
    conn = get_conn()
    user = conn.execute(
        "SELECT id, employee_id, name, role, department_id, annual_leave, used_leave FROM users WHERE id=? AND is_active=1",
        (int(payload["sub"]),)
    ).fetchone()
    conn.close()
    if not user:
        raise HTTPException(status_code=401, detail="ユーザーが見つかりません。")
    return dict(user)


def require_admin(user=None):
    if user["role"] not in ("admin", "manager"):
        raise HTTPException(status_code=403, detail="管理者権限が必要です。")
