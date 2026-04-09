"""사용자 관련 Pydantic 스키마."""
from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, EmailStr, field_validator


class UserRegister(BaseModel):
    email: EmailStr
    password: str
    name: str
    target_job_category: Optional[str] = None
    target_job_keywords: Optional[List[str]] = None

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("비밀번호는 최소 8자 이상이어야 합니다.")
        return v


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserUpdate(BaseModel):
    name: Optional[str] = None
    target_job_category: Optional[str] = None
    target_job_keywords: Optional[List[str]] = None


class UserResponse(BaseModel):
    id: str
    email: str
    name: str
    target_job_category: Optional[str]
    target_job_keywords: Optional[List[str]]
    created_at: datetime

    model_config = {"from_attributes": True}


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserResponse


class RefreshRequest(BaseModel):
    refresh_token: str
