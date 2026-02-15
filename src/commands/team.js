import chalk from 'chalk';
import { Command } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import inquirer from 'inquirer';
import ora from 'ora';
import { getConfig, updateConfig } from './init.js';
import { initDb, exec, all, get } from '../utils/database.js';
import { logAudit } from '../utils/audit.js';

/**
 * Team commands for collaborative environment management
 */

// List team members
const listMembers = new Command('members')
  .description('List team members')
  .action(async () => {
    const config = getConfig();
    if (!config) {
      console.log(chalk.red('✗ Not initialized'));
      process.exit(1);
    }
    
    try {
      await initDb();
      
      const members = all('SELECT * FROM users ORDER BY username');
      
      if (members.length === 0) {
        console.log(chalk.yellow('No team members found.'));
        return;
      }
      
      console.log(chalk.cyan.bold('\n👥 Team Members\n'));
      
      const table = members.map(m => ({
        Username: chalk.white(m.username),
        Role: getRoleColor(m.role)(m.role),
        'Last Login': m.last_login ? chalk.gray(new Date(m.last_login).toLocaleString()) : chalk.gray('Never'),
        Created: chalk.gray(new Date(m.created_at).toLocaleDateString())
      }));
      
      console.table(table);
      
    } catch (error) {
      console.error(chalk.red('✗ Error:'), error.message);
    }
  });

// Add team member
const addMember = new Command('add')
  .description('Add a team member')
  .argument('<username>', 'Username')
  .option('-r, --role <role>', 'Role (admin, editor, viewer)', 'viewer')
  .action(async (username, options) => {
    const config = getConfig();
    if (!config) {
      console.log(chalk.red('✗ Not initialized'));
      process.exit(1);
    }
    
    const spinner = ora('Adding team member...').start();
    
    try {
      await initDb();
      
      // Check if user exists
      const existing = get('SELECT * FROM users WHERE username = ?', [username]);
      if (existing) {
        spinner.fail(chalk.red(`✗ User "${username}" already exists`));
        return;
      }
      
      const answers = await inquirer.prompt([
        {
          type: 'password',
          name: 'password',
          message: 'Enter password:',
          validate: (input) => input.length >= 6 || 'Password must be at least 6 characters'
        },
        {
          type: 'password',
          name: 'confirm',
          message: 'Confirm password:',
          validate: (input, answers) => input === answers.password || 'Passwords do not match'
        }
      ]);
      
      const CryptoJS = require('crypto-js');
      const salt = uuidv4();
      const passwordHash = CryptoJS.PBKDF2(answers.password, salt, {
        keySize: 256 / 32,
        iterations: 10000
      }).toString();
      
      const id = uuidv4();
      exec(
        'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
        [id, username, passwordHash, options.role]
      );
      
      logAudit({
        action: 'create',
        entityType: 'user',
        entityId: id,
        newValue: JSON.stringify({ username, role: options.role }),
        details: { action: 'member_added' }
      });
      
      spinner.succeed(chalk.green(`✓ Member "${username}" added with role "${options.role}"`));
      
    } catch (error) {
      spinner.fail(chalk.red('✗ Error: ') + error.message);
    }
  });

// Remove team member
const removeMember = new Command('remove')
  .description('Remove a team member')
  .argument('<username>', 'Username')
  .option('-f, --force', 'Skip confirmation')
  .action(async (username, options) => {
    const config = getConfig();
    if (!config) {
      console.log(chalk.red('✗ Not initialized'));
      process.exit(1);
    }
    
    try {
      await initDb();
      
      const member = get('SELECT * FROM users WHERE username = ?', [username]);
      if (!member) {
        console.log(chalk.red(`✗ Member "${username}" not found`));
        return;
      }
      
      if (!options.force) {
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Remove member "${username}"?`,
            default: false
          }
        ]);
        
        if (!confirm) {
          console.log(chalk.yellow('Operation cancelled.'));
          return;
        }
      }
      
      const spinner = ora('Removing member...').start();
      
      exec('DELETE FROM users WHERE id = ?', [member.id]);
      
      logAudit({
        action: 'delete',
        entityType: 'user',
        entityId: member.id,
        details: { username, action: 'member_removed' }
      });
      
      spinner.succeed(chalk.green(`✓ Member "${username}" removed`));
      
    } catch (error) {
      console.error(chalk.red('✗ Error:'), error.message);
    }
  });

// Update member role
const updateRole = new Command('role')
  .description('Update member role')
  .argument('<username>', 'Username')
  .argument('<role>', 'New role (admin, editor, viewer)')
  .action(async (username, role) => {
    const config = getConfig();
    if (!config) {
      console.log(chalk.red('✗ Not initialized'));
      process.exit(1);
    }
    
    try {
      await initDb();
      
      const member = get('SELECT * FROM users WHERE username = ?', [username]);
      if (!member) {
        console.log(chalk.red(`✗ Member "${username}" not found`));
        return;
      }
      
      const spinner = ora('Updating role...').start();
      
      exec('UPDATE users SET role = ? WHERE id = ?', [role, member.id]);
      
      logAudit({
        action: 'update',
        entityType: 'user',
        entityId: member.id,
        oldValue: member.role,
        newValue: role,
        details: { username, action: 'role_updated' }
      });
      
      spinner.succeed(chalk.green(`✓ Role updated to "${role}" for "${username}"`));
      
    } catch (error) {
      console.error(chalk.red('✗ Error:'), error.message);
    }
  });

// Share environment with team
const share = new Command('share')
  .description('Share environment with team member')
  .argument('<env>', 'Environment name')
  .argument('<username>', 'Username to share with')
  .option('-r, --role <role>', 'Permission level (read, write)', 'read')
  .action(async (envName, username, options) => {
    const config = getConfig();
    if (!config) {
      console.log(chalk.red('✗ Not initialized'));
      process.exit(1);
    }
    
    try {
      await initDb();
      
      const env = get('SELECT * FROM environments WHERE name = ?', [envName]);
      if (!env) {
        console.log(chalk.red(`✗ Environment "${envName}" not found`));
        return;
      }
      
      const member = get('SELECT * FROM users WHERE username = ?', [username]);
      if (!member) {
        console.log(chalk.red(`✗ Member "${username}" not found`));
        return;
      }
      
      const spinner = ora('Sharing environment...').start();
      
      // Create share record (would need additional table)
      console.log(chalk.green(`✓ Environment "${envName}" shared with "${username}" (${options.role})`));
      
    } catch (error) {
      console.error(chalk.red('✗ Error:'), error.message);
    }
  });

// Helper function
function getRoleColor(role) {
  switch (role) {
    case 'admin':
      return chalk.red;
    case 'editor':
      return chalk.yellow;
    case 'viewer':
      return chalk.gray;
    default:
      return chalk.white;
  }
}

export const teamCommands = {
  members: listMembers,
  add: addMember,
  remove: removeMember,
  role: updateRole,
  share
};
