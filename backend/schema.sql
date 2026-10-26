-- Reference only: the backend creates these tables automatically on startup.
-- Use this if you prefer to create the database by hand.

CREATE DATABASE IF NOT EXISTS npsb_dispute CHARACTER SET utf8mb4;
USE npsb_dispute;

-- ---------------------------------------------------------------- authentication
-- All auth timestamps are UTC. There are no roles: every user can use every feature.

CREATE TABLE users (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  username            VARCHAR(30)  NOT NULL UNIQUE,      -- lowercase
  email               VARCHAR(254) NULL UNIQUE,          -- lowercase; used for sign-in and password reset
  full_name           VARCHAR(100) NOT NULL DEFAULT '',
  role                VARCHAR(10)  NOT NULL DEFAULT 'user',   -- admin / user
  email_verified      BOOLEAN NOT NULL DEFAULT FALSE,    -- proven with an emailed code; needed to sign in
  email_verified_at   DATETIME NULL,
  pending_email       VARCHAR(254) NULL,                 -- new address waiting for its confirmation code
  password_hash       VARCHAR(200) NOT NULL,             -- PBKDF2-SHA256, never the plain password
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,     -- disabled accounts cannot sign in
  token_version       INT NOT NULL DEFAULT 0,            -- +1 = all issued access tokens become invalid
  failed_login_count  INT NOT NULL DEFAULT 0,
  locked_until        DATETIME NULL,                     -- set after too many wrong passwords
  last_login_at       DATETIME NULL,
  password_changed_at DATETIME NULL,
  created_at          DATETIME NOT NULL,
  updated_at          DATETIME NULL
);

-- One row per refresh token. A session (browser/device) is a chain of rotated tokens
-- sharing one family_id; only the newest token of a chain is not revoked.
CREATE TABLE refresh_tokens (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  user_id        INT NOT NULL,
  token_hash     CHAR(64) NOT NULL UNIQUE,     -- SHA-256 of the cookie value
  family_id      VARCHAR(32) NOT NULL,
  remember_me    BOOLEAN NOT NULL DEFAULT FALSE,
  user_agent     VARCHAR(255) NOT NULL DEFAULT '',
  ip_address     VARCHAR(45)  NOT NULL DEFAULT '',
  created_at     DATETIME NOT NULL,
  last_used_at   DATETIME NOT NULL,
  expires_at     DATETIME NOT NULL,
  revoked_at     DATETIME NULL,
  replaced_by_id INT NULL,                     -- the token this one was rotated into
  INDEX (user_id),
  INDEX (family_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 6-digit codes emailed to prove an address is real (purpose: verify = account email,
-- change = new email from the profile). A new code replaces older ones.
CREATE TABLE email_verification_codes (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  email      VARCHAR(254) NOT NULL,            -- address the code was sent to
  purpose    VARCHAR(10)  NOT NULL,
  code_hash  CHAR(64) NOT NULL,                -- SHA-256, never the code itself
  attempts   INT NOT NULL DEFAULT 0,           -- 5 wrong tries and the code stops working
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at    DATETIME NULL,
  INDEX (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE password_reset_tokens (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,         -- SHA-256 of the emailed token
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at    DATETIME NULL,                    -- one-time use
  ip_address VARCHAR(45) NOT NULL DEFAULT '',
  INDEX (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Security audit log: sign-ins, failures, lockouts, sign-outs, password, email and account changes
CREATE TABLE auth_events (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NULL,
  username   VARCHAR(254) NOT NULL DEFAULT '',  -- what was typed (for failed sign-ins)
  event      VARCHAR(40)  NOT NULL,             -- login_success, login_failed, logout, password_reset, ...
  success    BOOLEAN NOT NULL DEFAULT TRUE,
  detail     VARCHAR(255) NOT NULL DEFAULT '',
  ip_address VARCHAR(45)  NOT NULL DEFAULT '',
  user_agent VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  INDEX (user_id),
  INDEX (created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------- business data

CREATE TABLE partners (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  institution_code VARCHAR(20)  NOT NULL UNIQUE,
  name             VARCHAR(150) NOT NULL,
  is_active        BOOLEAN      NOT NULL DEFAULT TRUE
);

CREATE TABLE partner_emails (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  partner_id INT          NOT NULL,
  email      VARCHAR(200) NOT NULL,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  problem    VARCHAR(255) NULL,     -- refused by the mail server: left out of new emails until fixed
  problem_at DATETIME     NULL,
  FOREIGN KEY (partner_id) REFERENCES partners(id)
);

CREATE TABLE trusted_devices (   -- "Keep me signed in": password only, no emailed code
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT          NOT NULL,
  token_hash   VARCHAR(64)  NOT NULL UNIQUE,
  user_agent   VARCHAR(255) NOT NULL DEFAULT '',
  ip_address   VARCHAR(45)  NOT NULL DEFAULT '',
  created_at   DATETIME     NOT NULL,
  last_used_at DATETIME     NOT NULL,
  expires_at   DATETIME     NOT NULL,
  revoked_at   DATETIME     NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE uploads (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  filename     VARCHAR(255) NOT NULL,
  uploaded_at  DATETIME     NOT NULL,
  total_rows   INT NOT NULL DEFAULT 0,
  valid_rows   INT NOT NULL DEFAULT 0,
  unknown_rows INT NOT NULL DEFAULT 0,
  file_content LONGBLOB     NULL      -- original file, for downloading valid / faulty rows
);

CREATE TABLE transactions (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  upload_id             INT NOT NULL,
  excel_row             INT NOT NULL,
  txn_datetime          DATETIME      NOT NULL,
  rrn                   VARCHAR(30)   NOT NULL,
  stan                  VARCHAR(20)   NOT NULL,
  amount                DECIMAL(14,2) NOT NULL,
  source_account        VARCHAR(40)   NOT NULL,
  beneficiary_account   VARCHAR(40)   NOT NULL,
  txn_type              VARCHAR(50)   NOT NULL,
  response_code         VARCHAR(10)   NOT NULL,
  nagad_status          VARCHAR(30)   NOT NULL,
  dest_institution_code VARCHAR(20)   NOT NULL,
  dest_partner_name     VARCHAR(150)  NOT NULL,
  is_unknown            BOOLEAN       NOT NULL DEFAULT FALSE,
  FOREIGN KEY (upload_id) REFERENCES uploads(id)
);

CREATE TABLE email_dispatches (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  upload_id    INT NOT NULL,
  partner_id   INT NOT NULL,
  to_emails    TEXT NOT NULL,
  cc_emails    TEXT NOT NULL,
  subject      VARCHAR(300) NOT NULL,
  body_html    TEXT NOT NULL,
  is_edited    BOOLEAN NOT NULL DEFAULT FALSE,              -- manually edited in the UI
  txn_count    INT NOT NULL,
  total_amount DECIMAL(14,2) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'PREPARED',  -- PREPARED / PENDING / SENDING / SENT / FAILED
  attempts     INT NOT NULL DEFAULT 0,
  error        TEXT NULL,
  sent_at      DATETIME NULL,
  delivery_issues TEXT NULL,                              -- JSON: recipients the mail server refused
  submitted_by VARCHAR(30) NULL,                          -- user who sent it for approval
  submitted_at DATETIME NULL,
  sent_by      VARCHAR(30) NULL,                          -- admin who sent it
  sending_since DATETIME NULL,                            -- claimed by an admin (no double sending)
  UNIQUE (upload_id, partner_id),   -- one email per partner per upload, never duplicated
  FOREIGN KEY (upload_id)  REFERENCES uploads(id),
  FOREIGN KEY (partner_id) REFERENCES partners(id)
);
