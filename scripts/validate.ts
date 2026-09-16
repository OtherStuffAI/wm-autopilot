type ValidationStep = {
  name: string;
  command: string[];
  reportOnly?: boolean;
};

const steps: ValidationStep[] = [
  {
    name: 'Whitespace',
    command: ['bun', 'run', 'whitespace:check'],
  },
  {
    name: 'Typecheck',
    command: ['bun', 'run', 'typecheck'],
  },
  {
    name: 'Lint',
    command: ['bun', 'run', 'lint:check'],
  },
  {
    name: 'Tests',
    command: ['bun', 'run', 'test'],
  },
  {
    name: 'Public-source quality',
    command: ['bun', 'run', 'quality:public-source'],
    reportOnly: true,
  },
  {
    name: 'Security audit',
    command: ['bun', 'run', 'security:audit'],
  },
  {
    name: 'Maintainability report',
    command: ['bun', 'run', 'maintainability:report'],
    reportOnly: true,
  },
];

const results: { name: string; status: 'passed' | 'failed' | 'reported'; code: number }[] = [];
let blockingFailure = false;

for (const step of steps) {
  console.log(`\n==> ${step.name}${step.reportOnly ? ' (report-only)' : ''}`);
  const proc = Bun.spawn(step.command, {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  const code = await proc.exited;

  if (code === 0) {
    results.push({ name: step.name, status: 'passed', code });
    continue;
  }

  if (step.reportOnly) {
    results.push({ name: step.name, status: 'reported', code });
    continue;
  }

  results.push({ name: step.name, status: 'failed', code });
  blockingFailure = true;
  break;
}

console.log('\nValidation summary');
for (const result of results) {
  const suffix = result.code === 0 ? '' : ` (exit ${result.code})`;
  console.log(`- ${result.name}: ${result.status}${suffix}`);
}

if (blockingFailure) {
  process.exit(1);
}
