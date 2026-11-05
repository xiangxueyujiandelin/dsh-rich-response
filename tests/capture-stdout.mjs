/**
 * 沙箱友好的子进程输出捕获。
 *
 * 背景：Windows 上 DSH 的受限令牌沙箱禁止管道 stdio，
 * 因此子进程默认的 `stdio: 'pipe'` 会直接 EPERM
 * （见 2026-11-05 的 mutation-test 基线假失败）。
 *
 * 做法：把子进程 stdout 接到一个真实文件句柄上，跑完再读文件。
 * 文件句柄由父进程打开，子进程只继承句柄，不触发沙箱的管道限制。
 */

import { closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * 运行命令并捕获 stdout（stderr 丢弃，调用方用 status 判断成败）。
 *
 * @param {string} command 可执行文件
 * @param {string[]} args 参数
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, root: string }} options
 * @returns {{ status: number | null, stdout: string, error?: Error }}
 */
export function captureStdout(command, args, { cwd, env, root }) {
  const file = join(root, `.tmp-capture-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
  const fd = openSync(file, 'w')
  try {
    const result = spawnSync(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', fd, 'ignore'],
    })
    return {
      status: result.status,
      stdout: readFileSync(file, 'utf8'),
      error: result.error,
    }
  } finally {
    closeSync(fd)
    rmSync(file, { force: true })
  }
}
