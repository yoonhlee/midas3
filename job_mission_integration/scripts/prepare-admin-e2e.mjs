// 관리자 화면 E2E 준비: missions/를 test-results/admin-missions/로 통째로 복사한다.
// 테스트 서버는 MISSIONS_DIR로 이 복사본을 쓰므로, 카탈로그에 추가 · 삭제해도 저장소의 missions/는 바뀌지 않는다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "missions");
const target = path.join(root, "test-results", "admin-missions");

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true });
console.log(`admin e2e missions: ${path.relative(root, source)} -> ${path.relative(root, target)}`);
