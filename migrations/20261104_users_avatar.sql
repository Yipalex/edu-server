-- 泽曦书画统一账号体系：用户头像（base64 PNG，跨系统同步）
-- 三个库（yj/quan/jz）结构一致，都需要这两列
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;
GRANT SELECT (avatar_data, avatar_updated_at), UPDATE (avatar_data, avatar_updated_at) ON users TO zexi;
