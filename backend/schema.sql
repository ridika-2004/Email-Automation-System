-- Reference only: the backend creates these tables automatically on startup.
-- Use this if you prefer to create the database by hand.

CREATE DATABASE IF NOT EXISTS npsb_dispute CHARACTER SET utf8mb4;
USE npsb_dispute;

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
  FOREIGN KEY (partner_id) REFERENCES partners(id)
);

CREATE TABLE uploads (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  filename     VARCHAR(255) NOT NULL,
  uploaded_at  DATETIME     NOT NULL,
  total_rows   INT NOT NULL DEFAULT 0,
  valid_rows   INT NOT NULL DEFAULT 0,
  unknown_rows INT NOT NULL DEFAULT 0
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
  txn_count    INT NOT NULL,
  total_amount DECIMAL(14,2) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'PREPARED',  -- PREPARED / SENT / FAILED
  attempts     INT NOT NULL DEFAULT 0,
  error        TEXT NULL,
  sent_at      DATETIME NULL,
  UNIQUE (upload_id, partner_id),   -- one email per partner per upload, never duplicated
  FOREIGN KEY (upload_id)  REFERENCES uploads(id),
  FOREIGN KEY (partner_id) REFERENCES partners(id)
);
