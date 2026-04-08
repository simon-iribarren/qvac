// @ts-ignore brittle has no type declarations
import test from "brittle";
import {
  createProgressThrottle,
  PROGRESS_THROTTLE_MS,
} from "@/server/rpc/progress-throttle";

type BrittleT = {
  is: (a: unknown, b: unknown, msg?: string) => void;
  ok: (v: unknown, msg?: string) => void;
  alike: (a: unknown, b: unknown, msg?: string) => void;
};

const T0 = 1_000_000;

test("immediate write when throttle window has elapsed", (t: BrittleT) => {
  const written: number[] = [];
  let time = T0;
  const throttle = createProgressThrottle<number>(
    (v) => written.push(v),
    () => time,
  );

  throttle.push(1);
  t.alike(written, [1], "first event writes immediately");

  time += PROGRESS_THROTTLE_MS;
  throttle.push(2);
  t.alike(written, [1, 2], "event after full window writes immediately");

  throttle.flush();
});

test("events within the same window are buffered, not dropped", (t: BrittleT) => {
  const written: number[] = [];
  let time = T0;
  const throttle = createProgressThrottle<number>(
    (v) => written.push(v),
    () => time,
  );

  throttle.push(1);
  t.alike(written, [1], "first event writes immediately");

  time += 10;
  throttle.push(2);
  throttle.push(3);
  throttle.push(4);
  t.alike(written, [1], "buffered events not yet written");

  throttle.flush();
  t.alike(written, [1, 2, 3, 4], "flush writes all buffered events");
});

test("flush is a no-op when buffer is empty", (t: BrittleT) => {
  const written: number[] = [];
  let time = T0;
  const throttle = createProgressThrottle<number>(
    (v) => written.push(v),
    () => time,
  );

  throttle.flush();
  t.alike(written, [], "nothing written on empty flush");

  throttle.push(1);
  throttle.flush();
  t.alike(written, [1], "only the immediate write");

  throttle.flush();
  t.alike(written, [1], "second flush is safe");
});

test("timer flush writes all buffered events", async (t: BrittleT) => {
  const written: number[] = [];
  let time = T0;
  const throttleMs = 50;
  const throttle = createProgressThrottle<number>(
    (v) => written.push(v),
    () => time,
    throttleMs,
  );

  throttle.push(1);
  time += 10;
  throttle.push(2);
  throttle.push(3);

  t.alike(written, [1], "only immediate write before timer");

  time += throttleMs;
  await new Promise((r) => setTimeout(r, throttleMs + 10));

  t.alike(written, [1, 2, 3], "timer flushed all buffered events");
  throttle.flush();
});

test("simulates rapid finetune-like progress: no events lost", (t: BrittleT) => {
  const written: number[] = [];
  let time = T0;
  const throttle = createProgressThrottle<number>(
    (v) => written.push(v),
    () => time,
  );

  for (let batch = 1; batch <= 8; batch++) {
    throttle.push(batch);
    time += 30;
  }

  throttle.flush();

  t.is(written.length, 8, "all 8 batches delivered");

  const sorted = [...written].sort((a, b) => a - b);
  t.alike(sorted, [1, 2, 3, 4, 5, 6, 7, 8], "no events lost");
});

test("mixed fast and slow events: all delivered", (t: BrittleT) => {
  const written: number[] = [];
  let time = T0;
  const throttle = createProgressThrottle<number>(
    (v) => written.push(v),
    () => time,
  );

  throttle.push(1);
  time += PROGRESS_THROTTLE_MS;
  throttle.push(2);

  time += 10;
  throttle.push(3);
  throttle.push(4);

  time += PROGRESS_THROTTLE_MS;
  throttle.push(5);

  time += 5;
  throttle.push(6);

  throttle.flush();

  t.is(written.length, 6, "all 6 events delivered");

  const sorted = [...written].sort((a, b) => a - b);
  t.alike(sorted, [1, 2, 3, 4, 5, 6], "no events lost");
});

test("flush on error path delivers pending events", (t: BrittleT) => {
  const written: number[] = [];
  let time = T0;
  const throttle = createProgressThrottle<number>(
    (v) => written.push(v),
    () => time,
  );

  throttle.push(1);
  time += 10;
  throttle.push(2);
  throttle.push(3);

  throttle.flush();
  t.alike(written, [1, 2, 3], "all events flushed even on error path");

  throttle.flush();
  t.alike(written, [1, 2, 3], "double flush is safe");
});

test("high-volume download-like burst: all events preserved", (t: BrittleT) => {
  const written: number[] = [];
  let time = T0;
  const throttle = createProgressThrottle<number>(
    (v) => written.push(v),
    () => time,
  );

  for (let i = 0; i < 100; i++) {
    throttle.push(i);
    time += 1;
  }

  throttle.flush();

  t.is(written.length, 100, "all 100 events delivered");
  t.is(written[0], 0, "first event present");
  t.is(written[written.length - 1], 99, "last event present");
});
