import type { JobRequest, JobResult, WorkerOutMsg } from '../core/types';

interface Task {
  req: JobRequest;
  onProgress: (stage: string, progress: number) => void;
  resolve: (r: JobResult) => void;
  reject: (e: Error) => void;
}

/** File de traitement : chaque groupe part dans un worker dédié, plusieurs en parallèle. */
export class WorkerPool {
  private idle: Worker[] = [];
  private queue: Task[] = [];
  private active = 0;

  constructor(private size: () => number) {}

  run(req: JobRequest, onProgress: Task['onProgress']): Promise<JobResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ req, onProgress, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    while (this.queue.length && this.active < this.size()) {
      const task = this.queue.shift()!;
      const worker = this.idle.pop() ?? new Worker(new URL('./hdri.worker.ts', import.meta.url), { type: 'module' });
      this.active++;
      const done = (keep: boolean) => {
        worker.onmessage = null;
        worker.onerror = null;
        this.active--;
        if (keep) this.idle.push(worker);
        else worker.terminate();
        this.pump();
      };
      worker.onmessage = (e: MessageEvent<WorkerOutMsg>) => {
        const msg = e.data;
        if (msg.id !== task.req.id) return;
        if (msg.type === 'progress') task.onProgress(msg.stage, msg.progress);
        else if (msg.type === 'done') { done(true); task.resolve(msg.result); }
        else { done(true); task.reject(new Error(msg.message)); }
      };
      worker.onerror = (e) => {
        done(false);
        task.reject(new Error(e.message || 'Le traitement a échoué (mémoire insuffisante ?)'));
      };
      worker.postMessage(task.req);
    }
  }
}
