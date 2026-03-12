import type { CostReport, Finding } from "../types.js";
import { formatCurrency } from "./cost-calculator.js";

export function formatConsoleReport(report: CostReport): string {
  const lines: string[] = [];

  lines.push("╔═══════════════════════════════════════════════════════════════════════╗");
  lines.push("║           AWS COST OPTIMIZATION REPORT                                ║");
  lines.push("╚═══════════════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Regions analyzed: ${report.regions.join(", ")}`);
  lines.push("");

  // Summary
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("SUMMARY");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`Total Findings: ${report.summary.totalFindings}`);
  lines.push(
    `Potential Monthly Savings: ${formatCurrency(report.summary.totalPotentialMonthlySavings)}`
  );
  lines.push("");
  lines.push("Findings by Priority:");
  lines.push(`  🔴 High:   ${report.summary.findingsByPriority.high}`);
  lines.push(`  🟡 Medium: ${report.summary.findingsByPriority.medium}`);
  lines.push(`  🟢 Low:    ${report.summary.findingsByPriority.low}`);
  lines.push("");

  // Savings by service
  if (Object.keys(report.summary.savingsByService).length > 0) {
    lines.push("Savings by Service:");
    const sortedServices = Object.entries(report.summary.savingsByService).sort(
      (a, b) => b[1] - a[1]
    );
    for (const [service, savings] of sortedServices) {
      lines.push(`  ${service.padEnd(20)} ${formatCurrency(savings)}`);
    }
    lines.push("");
  }

  // Top recommendations
  if (report.topRecommendations.length > 0) {
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("TOP 10 RECOMMENDATIONS");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("");

    report.topRecommendations.slice(0, 10).forEach((finding, index) => {
      const priorityIcon =
        finding.priority === "high" ? "🔴" : finding.priority === "medium" ? "🟡" : "🟢";
      lines.push(
        `${index + 1}. ${priorityIcon} [${finding.service}] ${finding.resourceType}`
      );
      lines.push(`   Resource: ${finding.resourceId}`);
      lines.push(`   Region: ${finding.region}`);
      lines.push(`   Issue: ${finding.issue}`);
      lines.push(`   💰 Savings: ${formatCurrency(finding.potentialMonthlySavings)}/month`);
      lines.push(`   ✅ Action: ${finding.recommendation}`);
      lines.push("");
    });
  }

  // Detailed results by analyzer
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("DETAILED RESULTS BY ANALYZER");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("");

  for (const result of report.results) {
    if (result.error) {
      lines.push(`❌ ${result.analyzerName} (${result.region}): ERROR - ${result.error}`);
      lines.push("");
      continue;
    }

    lines.push(
      `✓ ${result.analyzerName} (${result.region}): ${result.findings.length} findings, ${formatCurrency(result.totalPotentialSavings)} potential savings`
    );

    if (result.findings.length > 0) {
      result.findings.slice(0, 5).forEach((finding) => {
        lines.push(`  - ${finding.resourceId}: ${finding.issue}`);
      });
      if (result.findings.length > 5) {
        lines.push(`  ... and ${result.findings.length - 5} more`);
      }
    }
    lines.push("");
  }

  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`Full report saved to: cost-optimization-report-${new Date().toISOString().split("T")[0]}.json`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  return lines.join("\n");
}

export function generateCSVReport(report: CostReport): string {
  const lines: string[] = [];
  lines.push(
    "Service,Resource Type,Resource ID,Region,Priority,Issue,Recommendation,Monthly Cost,Potential Savings"
  );

  for (const result of report.results) {
    for (const finding of result.findings) {
      const row = [
        finding.service,
        finding.resourceType,
        finding.resourceId,
        finding.region,
        finding.priority,
        `"${finding.issue.replace(/"/g, '""')}"`,
        `"${finding.recommendation.replace(/"/g, '""')}"`,
        finding.estimatedMonthlyCost.toFixed(2),
        finding.potentialMonthlySavings.toFixed(2),
      ];
      lines.push(row.join(","));
    }
  }

  return lines.join("\n");
}

export function generateHTMLReport(report: CostReport): string {
  const priorityBadge = (priority: string) => {
    const colors = {
      high: '#ef4444',
      medium: '#f59e0b',
      low: '#10b981'
    };
    return `<span class="priority-badge priority-${priority}" style="background-color: ${colors[priority as keyof typeof colors]};">${priority.toUpperCase()}</span>`;
  };

  const savingsByService = Object.entries(report.summary.savingsByService)
    .sort((a, b) => b[1] - a[1])
    .map(([service, savings]) => `
      <tr>
        <td>${service}</td>
        <td class="savings">${formatCurrency(savings)}</td>
        <td>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${(savings / report.summary.totalPotentialMonthlySavings * 100).toFixed(1)}%;"></div>
          </div>
        </td>
      </tr>
    `).join('');

  const topRecommendations = report.topRecommendations.slice(0, 10).map((finding, index) => `
    <div class="finding-card">
      <div class="finding-header">
        <div class="finding-title">
          <span class="rank">#${index + 1}</span>
          ${priorityBadge(finding.priority)}
          <span class="service-tag">${finding.service}</span>
        </div>
        <div class="finding-savings">${formatCurrency(finding.potentialMonthlySavings)}<span class="period">/month</span></div>
      </div>
      <div class="finding-body">
        <div class="finding-detail">
          <strong>Resource:</strong> <code>${finding.resourceType}</code> - <code>${finding.resourceId}</code>
        </div>
        <div class="finding-detail">
          <strong>Region:</strong> ${finding.region}
        </div>
        <div class="finding-detail">
          <strong>Issue:</strong> ${finding.issue}
        </div>
        <div class="finding-detail recommendation">
          <strong>Recommendation:</strong> ${finding.recommendation}
        </div>
        <div class="finding-detail">
          <strong>Current Cost:</strong> ${formatCurrency(finding.estimatedMonthlyCost)}/month
        </div>
      </div>
    </div>
  `).join('');

  const analyzerResults = report.results.map(result => {
    if (result.error) {
      return `
        <div class="analyzer-result error">
          <div class="analyzer-header">
            <h3>❌ ${result.analyzerName} (${result.region})</h3>
          </div>
          <div class="error-message">Error: ${result.error}</div>
        </div>
      `;
    }

    const findings = result.findings.slice(0, 5).map(finding => `
      <div class="finding-item">
        ${priorityBadge(finding.priority)}
        <code>${finding.resourceId}</code>
        <span class="finding-issue">${finding.issue}</span>
        <span class="finding-savings-small">${formatCurrency(finding.potentialMonthlySavings)}</span>
      </div>
    `).join('');

    const moreFindings = result.findings.length > 5
      ? `<div class="more-findings">... and ${result.findings.length - 5} more findings</div>`
      : '';

    return `
      <div class="analyzer-result">
        <div class="analyzer-header">
          <h3>✓ ${result.analyzerName}</h3>
          <div class="analyzer-stats">
            <span>${result.region}</span>
            <span class="separator">•</span>
            <span>${result.findings.length} findings</span>
            <span class="separator">•</span>
            <span class="savings">${formatCurrency(result.totalPotentialSavings)} potential savings</span>
          </div>
        </div>
        <div class="findings-list">
          ${findings}
          ${moreFindings}
        </div>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AWS Cost Optimization Report - ${report.generatedAt}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      line-height: 1.6;
      color: #1f2937;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 2rem;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      overflow: hidden;
    }

    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 3rem 2rem;
      text-align: center;
    }

    .header h1 {
      font-size: 2.5rem;
      margin-bottom: 0.5rem;
      font-weight: 700;
    }

    .header-meta {
      font-size: 0.95rem;
      opacity: 0.95;
    }

    .content {
      padding: 2rem;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }

    .summary-card {
      background: linear-gradient(135deg, #f6f8fb 0%, #ffffff 100%);
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 1.5rem;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
    }

    .summary-card h3 {
      font-size: 0.875rem;
      text-transform: uppercase;
      color: #6b7280;
      margin-bottom: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.5px;
    }

    .summary-value {
      font-size: 2rem;
      font-weight: 700;
      color: #1f2937;
    }

    .summary-value.savings {
      color: #10b981;
      font-size: 2.5rem;
    }

    .priority-breakdown {
      display: flex;
      gap: 1rem;
      margin-top: 1rem;
    }

    .priority-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.9rem;
    }

    .priority-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }

    .priority-dot.high { background: #ef4444; }
    .priority-dot.medium { background: #f59e0b; }
    .priority-dot.low { background: #10b981; }

    .section {
      margin: 3rem 0;
    }

    .section h2 {
      font-size: 1.75rem;
      margin-bottom: 1.5rem;
      color: #1f2937;
      font-weight: 700;
      border-bottom: 3px solid #667eea;
      padding-bottom: 0.5rem;
    }

    .table-container {
      overflow-x: auto;
      border-radius: 8px;
      border: 1px solid #e5e7eb;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      background: white;
    }

    th, td {
      padding: 1rem;
      text-align: left;
    }

    th {
      background: #f9fafb;
      font-weight: 600;
      color: #374151;
      border-bottom: 2px solid #e5e7eb;
    }

    tr:not(:last-child) td {
      border-bottom: 1px solid #f3f4f6;
    }

    tr:hover td {
      background: #f9fafb;
    }

    .savings {
      color: #10b981;
      font-weight: 600;
    }

    .progress-bar {
      width: 100%;
      height: 8px;
      background: #e5e7eb;
      border-radius: 4px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
      border-radius: 4px;
      transition: width 0.3s ease;
    }

    .finding-card {
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
      transition: transform 0.2s, box-shadow 0.2s;
    }

    .finding-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 16px rgba(0, 0, 0, 0.1);
    }

    .finding-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      padding-bottom: 1rem;
      border-bottom: 2px solid #f3f4f6;
    }

    .finding-title {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .rank {
      font-size: 1.25rem;
      font-weight: 700;
      color: #6b7280;
    }

    .priority-badge {
      padding: 0.25rem 0.75rem;
      border-radius: 6px;
      color: white;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .service-tag {
      padding: 0.25rem 0.75rem;
      background: #f3f4f6;
      border-radius: 6px;
      font-size: 0.875rem;
      font-weight: 600;
      color: #4b5563;
    }

    .finding-savings {
      font-size: 1.75rem;
      font-weight: 700;
      color: #10b981;
    }

    .period {
      font-size: 0.875rem;
      font-weight: 400;
      color: #6b7280;
    }

    .finding-body {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .finding-detail {
      font-size: 0.95rem;
      line-height: 1.6;
    }

    .finding-detail strong {
      color: #4b5563;
      margin-right: 0.5rem;
    }

    .finding-detail.recommendation {
      padding: 1rem;
      background: #f0fdf4;
      border-left: 4px solid #10b981;
      border-radius: 6px;
    }

    code {
      background: #f3f4f6;
      padding: 0.125rem 0.5rem;
      border-radius: 4px;
      font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
      font-size: 0.875rem;
      color: #6b46c1;
    }

    .analyzer-result {
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }

    .analyzer-result.error {
      border-color: #fca5a5;
      background: #fef2f2;
    }

    .analyzer-header {
      margin-bottom: 1rem;
    }

    .analyzer-header h3 {
      font-size: 1.25rem;
      color: #1f2937;
      margin-bottom: 0.5rem;
    }

    .analyzer-stats {
      font-size: 0.875rem;
      color: #6b7280;
    }

    .separator {
      margin: 0 0.5rem;
      color: #d1d5db;
    }

    .error-message {
      color: #dc2626;
      padding: 0.75rem;
      background: white;
      border-radius: 6px;
      font-weight: 500;
    }

    .findings-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .finding-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem;
      background: #f9fafb;
      border-radius: 6px;
      font-size: 0.875rem;
    }

    .finding-issue {
      flex: 1;
      color: #4b5563;
    }

    .finding-savings-small {
      color: #10b981;
      font-weight: 600;
    }

    .more-findings {
      text-align: center;
      padding: 0.75rem;
      color: #6b7280;
      font-style: italic;
      font-size: 0.875rem;
    }

    .footer {
      text-align: center;
      padding: 2rem;
      color: #6b7280;
      border-top: 1px solid #e5e7eb;
      margin-top: 3rem;
    }

    @media print {
      body {
        background: white;
        padding: 0;
      }

      .container {
        box-shadow: none;
      }

      .finding-card {
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>AWS Cost Optimization Report</h1>
      <div class="header-meta">
        Generated: ${new Date(report.generatedAt).toLocaleString()} | Regions: ${report.regions.join(', ')}
      </div>
    </div>

    <div class="content">
      <div class="summary-grid">
        <div class="summary-card">
          <h3>Total Potential Savings</h3>
          <div class="summary-value savings">${formatCurrency(report.summary.totalPotentialMonthlySavings)}</div>
          <div style="margin-top: 0.5rem; font-size: 0.875rem; color: #6b7280;">per month</div>
        </div>

        <div class="summary-card">
          <h3>Total Findings</h3>
          <div class="summary-value">${report.summary.totalFindings}</div>
          <div class="priority-breakdown">
            <div class="priority-item">
              <div class="priority-dot high"></div>
              <span>${report.summary.findingsByPriority.high} High</span>
            </div>
            <div class="priority-item">
              <div class="priority-dot medium"></div>
              <span>${report.summary.findingsByPriority.medium} Medium</span>
            </div>
            <div class="priority-item">
              <div class="priority-dot low"></div>
              <span>${report.summary.findingsByPriority.low} Low</span>
            </div>
          </div>
        </div>

        <div class="summary-card">
          <h3>Analyzers Run</h3>
          <div class="summary-value">${report.analyzers.length}</div>
          <div style="margin-top: 0.5rem; font-size: 0.875rem; color: #6b7280;">${report.regions.length} region${report.regions.length > 1 ? 's' : ''} analyzed</div>
        </div>
      </div>

      ${Object.keys(report.summary.savingsByService).length > 0 ? `
      <div class="section">
        <h2>💰 Savings by Service</h2>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Potential Savings</th>
                <th>Percentage</th>
              </tr>
            </thead>
            <tbody>
              ${savingsByService}
            </tbody>
          </table>
        </div>
      </div>
      ` : ''}

      ${report.topRecommendations.length > 0 ? `
      <div class="section">
        <h2>🎯 Top 10 Recommendations</h2>
        ${topRecommendations}
      </div>
      ` : ''}

      <div class="section">
        <h2>📊 Detailed Results by Analyzer</h2>
        ${analyzerResults}
      </div>
    </div>

    <div class="footer">
      <p>AWS Cost Optimization Analyzer</p>
      <p style="font-size: 0.875rem; margin-top: 0.5rem;">
        This report identifies potential cost optimization opportunities. Review recommendations carefully before taking action.
      </p>
    </div>
  </div>
</body>
</html>`;
}
