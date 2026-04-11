import sqlite3
import os
from contextlib import contextmanager

DB_PATH = os.path.join(os.path.dirname(__file__), "interview.db")


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def get_db():
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS interviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_title TEXT NOT NULL,
                jd_text TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                total_score REAL,
                status TEXT NOT NULL DEFAULT 'created'
            );

            CREATE TABLE IF NOT EXISTS questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                interview_id INTEGER NOT NULL,
                question_text TEXT NOT NULL,
                question_type TEXT,
                order_num INTEGER NOT NULL,
                FOREIGN KEY (interview_id) REFERENCES interviews(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS answers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question_id INTEGER NOT NULL,
                answer_text TEXT NOT NULL,
                recorded_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                interview_id INTEGER NOT NULL UNIQUE,
                logic_score REAL,
                specificity_score REAL,
                job_relevance_score REAL,
                structure_score REAL,
                delivery_score REAL,
                total_score REAL,
                feedback_json TEXT,
                FOREIGN KEY (interview_id) REFERENCES interviews(id) ON DELETE CASCADE
            );
        """)
    print("DB 초기화 완료:", DB_PATH)
