from sqlalchemy import URL, create_engine, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from . import config


def mysql_url(database: str | None) -> URL:
    # URL.create handles special characters in the password (like @ or #)
    return URL.create(
        "mysql+pymysql",
        username=config.DB_USER,
        password=config.DB_PASSWORD,
        host=config.DB_HOST,
        port=config.DB_PORT,
        database=database,
    )


def create_database_if_missing():
    """Create the MySQL database (schema) if it does not exist yet,
    so you don't have to create it by hand in MySQL Workbench."""
    if config.DATABASE_URL:
        return
    server = create_engine(mysql_url(None))
    with server.connect() as conn:
        conn.execute(text(f"CREATE DATABASE IF NOT EXISTS `{config.DB_NAME}` CHARACTER SET utf8mb4"))
    server.dispose()


engine = create_engine(config.DATABASE_URL or mysql_url(config.DB_NAME), pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency: gives one DB session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
