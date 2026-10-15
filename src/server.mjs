import { createServer, createWorkbench } from './app.mjs';

const port = Number(process.env.PORT || 4318);
const { workbench, paths, runtime } = createWorkbench();
const server = createServer({ workbench, paths, port });

server.listen(port, '127.0.0.1', () => {
  console.log(`野望科技工作台已启动：http://127.0.0.1:${server.address().port}/`);
  if (process.env.YEWANG_NO_AUTOSTART !== '1' && workbench.state.workspace.mode === 'legacy-company') {
    runtime.ensureStarted().then(
      () => console.log('Codex 运行服务已就绪'),
      (error) => console.error('Codex 运行服务启动失败：', error.message),
    );
  }
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await workbench.stopRuntime().catch(() => {});
  workbench.store.save();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
