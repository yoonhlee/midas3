"""인증 API 엔드포인트."""
from fastapi import APIRouter, HTTPException, status
from jose import JWTError
from sqlalchemy import select

from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.dependencies import CurrentUser, DB
from app.models.user import User
from app.schemas.user import (
    RefreshRequest,
    TokenResponse,
    UserLogin,
    UserRegister,
    UserResponse,
    UserUpdate,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(data: UserRegister, db: DB) -> TokenResponse:
    existing = await db.execute(select(User).where(User.email == data.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="이미 사용 중인 이메일입니다.")
    user = User(
        email=data.email,
        password_hash=hash_password(data.password),
        name=data.name,
        target_job_category=data.target_job_category,
        target_job_keywords=data.target_job_keywords,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    return TokenResponse(
        access_token=create_access_token(str(user.id)),
        refresh_token=create_refresh_token(str(user.id)),
        user=UserResponse.model_validate(user),
    )


@router.post("/login", response_model=TokenResponse)
async def login(data: UserLogin, db: DB) -> TokenResponse:
    result = await db.execute(select(User).where(User.email == data.email))
    user = result.scalar_one_or_none()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="이메일 또는 비밀번호가 올바르지 않습니다.")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="비활성화된 계정입니다.")
    return TokenResponse(
        access_token=create_access_token(str(user.id)),
        refresh_token=create_refresh_token(str(user.id)),
        user=UserResponse.model_validate(user),
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(data: RefreshRequest, db: DB) -> TokenResponse:
    credentials_exception = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="유효하지 않은 리프레시 토큰입니다.")
    try:
        payload = decode_token(data.refresh_token)
        if payload.get("type") != "refresh":
            raise credentials_exception
        user_id: str = payload.get("sub")
    except JWTError:
        raise credentials_exception

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise credentials_exception
    return TokenResponse(
        access_token=create_access_token(str(user.id)),
        refresh_token=create_refresh_token(str(user.id)),
        user=UserResponse.model_validate(user),
    )


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: CurrentUser) -> UserResponse:
    return UserResponse.model_validate(current_user)


@router.patch("/me", response_model=UserResponse)
async def update_me(data: UserUpdate, current_user: CurrentUser, db: DB) -> UserResponse:
    if data.name is not None:
        current_user.name = data.name
    if data.target_job_category is not None:
        current_user.target_job_category = data.target_job_category
    if data.target_job_keywords is not None:
        current_user.target_job_keywords = data.target_job_keywords
    await db.flush()
    await db.refresh(current_user)
    return UserResponse.model_validate(current_user)
