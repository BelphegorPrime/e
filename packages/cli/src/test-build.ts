#!/usr/bin/env node

// Simple test to verify CLI works before building binaries
import { execSync } from 'child_process';

try {
  // Test that the CLI runs and shows help
  console.log('Testing CLI functionality...');
  const helpOutput = execSync('node dist/index.js --help', { encoding: 'utf8' });
  console.log('CLI help output:');
  console.log(helpOutput);
  
  // Test that the CLI runs the hello command
  console.log('\nTesting hello command...');
  const helloOutput = execSync('node dist/index.js hello', { encoding: 'utf8' });
  console.log('Hello command output:');
  console.log(helloOutput);
  
  console.log('\n✅ CLI tests passed successfully!');
} catch (error: any) {
  console.error('❌ CLI test failed:', error.message);
  process.exit(1);
}
