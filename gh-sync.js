#!/usr/bin/env node
// gh-sync: coleta PRs e Actions runs dos repos GitHub via gh CLI
// Pré-requisito: gh autenticado (gh auth login)
// Output: data/github.json
//
// Repos lidos de config.json → project.githubRepos

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

function loadConfigRepos() {
  const cfgPath = path.join(ROOT, 'config.json');
  if (!fs.existsSync(cfgPath)) return [];
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  return (cfg.project && cfg.project.githubRepos) || [];
}

const REPOS = loadConfigRepos();

if (REPOS.length === 0) {
  console.error('⚠️  Nenhum repo configurado. Edite config.json → project.githubRepos');
  process.exit(0); // exit 0 pra não quebrar o pipeline
}

function gh(cmd) {
  try {
    return execSync(`gh ${cmd}`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    console.error(`❌ gh ${cmd} falhou:`, e.message.slice(0, 200));
    return null;
  }
}

function ensureAccount() {
  // Em CI (GH_TOKEN env), o gh autentica automaticamente
  if (process.env.GH_TOKEN || process.env.CI) return;
  // Local: assume que o user já fez `gh auth login`
}

function fetchPRs(repo) {
  const fields = [
    'number', 'title', 'state', 'isDraft', 'createdAt', 'updatedAt',
    'mergedAt', 'closedAt', 'author', 'headRefName', 'baseRefName',
    'labels', 'reviewDecision', 'mergeable', 'additions', 'deletions',
    'url', 'body',
  ].join(',');
  const out = gh(`pr list --repo ${repo} --state all --limit 60 --json ${fields}`);
  if (!out) return [];
  try {
    return JSON.parse(out);
  } catch (e) {
    console.error(`❌ Parse PR list falhou pro ${repo}`);
    return [];
  }
}

function fetchRuns(repo) {
  const fields = [
    'databaseId', 'displayTitle', 'event', 'conclusion', 'status',
    'createdAt', 'updatedAt', 'headBranch', 'workflowName', 'url',
  ].join(',');
  const out = gh(`run list --repo ${repo} --limit 15 --json ${fields}`);
  if (!out) return [];
  try {
    return JSON.parse(out);
  } catch (e) {
    return [];
  }
}

function fetchRecentCommits(repo) {
  // Últimos 25 commits no main (sem --jq pra evitar problema de quoting no cmd)
  const out = gh(`api "repos/${repo}/commits?per_page=25"`);
  if (!out) return [];
  try {
    const arr = JSON.parse(out);
    return arr.map(c => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author.name,
      date: c.commit.author.date,
      url: c.html_url,
    }));
  } catch (e) {
    return [];
  }
}

// Extrai #NN do título do PR ou commit (todas ocorrências)
function extractCardIds(text) {
  if (!text) return [];
  const matches = [...text.matchAll(/#(\d{1,4})\b/g)];
  return [...new Set(matches.map(m => parseInt(m[1], 10)))];
}

function main() {
  ensureAccount();
  console.log('🔄 Sync com GitHub...');

  const data = {
    fetchedAt: new Date().toISOString(),
    repos: {},
    cardLinks: {}, // cardIdShort → { prs: [], commits: [] }
  };

  for (const repo of REPOS) {
    console.log(`  📦 ${repo.full}`);
    const prs = fetchPRs(repo.full);
    const runs = fetchRuns(repo.full);
    const commits = fetchRecentCommits(repo.full);

    data.repos[repo.name] = {
      full: repo.full,
      url: `https://github.com/${repo.full}`,
      prs,
      runs,
      commits,
      stats: {
        openPRs: prs.filter(p => p.state === 'OPEN').length,
        mergedRecent: prs.filter(p => p.mergedAt && (Date.now() - new Date(p.mergedAt).getTime()) < 7 * 86400000).length,
        runsFailed: runs.filter(r => r.conclusion === 'failure').length,
        runsLastSuccess: runs.find(r => r.conclusion === 'success'),
        runsLastFailure: runs.find(r => r.conclusion === 'failure'),
      },
    };

    // Linka com cards do Trello
    for (const pr of prs) {
      const ids = [
        ...extractCardIds(pr.title),
        ...extractCardIds(pr.body),
        ...extractCardIds(pr.headRefName),
      ];
      for (const id of ids) {
        if (!data.cardLinks[id]) data.cardLinks[id] = { prs: [], commits: [] };
        data.cardLinks[id].prs.push({
          repo: repo.name,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          isDraft: pr.isDraft,
          mergedAt: pr.mergedAt,
          closedAt: pr.closedAt,
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
          headRefName: pr.headRefName,
          author: pr.author && pr.author.login,
          reviewDecision: pr.reviewDecision,
          mergeable: pr.mergeable,
          additions: pr.additions,
          deletions: pr.deletions,
          url: pr.url,
        });
      }
    }

    for (const c of commits) {
      const ids = extractCardIds(c.message);
      for (const id of ids) {
        if (!data.cardLinks[id]) data.cardLinks[id] = { prs: [], commits: [] };
        data.cardLinks[id].commits.push({
          repo: repo.name,
          sha: c.sha.slice(0, 7),
          message: c.message.split('\n')[0].slice(0, 120),
          author: c.author,
          date: c.date,
          url: c.url,
        });
      }
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'github.json'), JSON.stringify(data, null, 2), 'utf8');

  // Output
  let totalPRs = 0, openPRs = 0, mergedPRs = 0, conflictPRs = 0;
  for (const repo of Object.values(data.repos)) {
    totalPRs += repo.prs.length;
    openPRs += repo.prs.filter(p => p.state === 'OPEN').length;
    mergedPRs += repo.prs.filter(p => p.state === 'MERGED').length;
    conflictPRs += repo.prs.filter(p => p.mergeable === 'CONFLICTING').length;
  }
  const linkedCards = Object.keys(data.cardLinks).length;

  console.log(`✅ Sync GitHub completo`);
  console.log(`   ${totalPRs} PRs (${openPRs} open · ${mergedPRs} merged · ${conflictPRs} conflicting)`);
  console.log(`   ${linkedCards} cards do Trello com PR/commit linkado`);
  for (const repo of Object.values(data.repos)) {
    const last = repo.stats.runsLastFailure;
    const successAfter = repo.stats.runsLastSuccess;
    if (last && (!successAfter || new Date(successAfter.createdAt) < new Date(last.createdAt))) {
      console.log(`   🚨 ${repo.full}: último Action falhou (${last.workflowName} em ${new Date(last.createdAt).toLocaleString('pt-BR')})`);
    }
  }
}

main();
