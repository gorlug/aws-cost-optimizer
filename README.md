# AWS Cost Optimization Analyzer

A comprehensive tool that analyzes your AWS account to identify cost optimization opportunities and provide actionable recommendations.

## Features

### What It Analyzes

- **CloudWatch Logs**: Inactive log groups, missing retention policies, large log groups
- **KMS Keys**: Unused customer-managed keys
- **EC2/EBS**: Unattached volumes, old snapshots, unused Elastic IPs, stopped instances
- **S3**: Buckets without lifecycle policies, versioning without cleanup rules, large old objects
- **Lambda**: Unused functions, over-provisioned memory/timeout
- **RDS**: Idle databases, old manual snapshots, stopped instances, over-provisioned instances
- **ELB**: Load balancers without targets, unused load balancers, deprecated Classic LBs

### What It Provides

- **Cost Estimates**: Monthly cost for each resource
- **Potential Savings**: Estimated savings if recommendations are implemented
- **Priority Ratings**: High/Medium/Low priority for each finding
- **Actionable Recommendations**: Specific steps to optimize costs
- **Multiple Formats**: Console output, JSON report, CSV export

## Installation

1. Install dependencies:
```bash
bun install
```

## Usage

### Basic Usage

Run the cost analyzer:
```bash
bun run cost-analyzer
```

Or using npm script:
```bash
bun run cost-analyzer
```

### Configuration

Edit `cost-analyzer/config.ts` to customize:

```typescript
export const DEFAULT_CONFIG: Config = {
  regions: ["eu-central-1"], // Add more regions
  thresholds: {
    inactiveDays: 30,        // Consider resources inactive after N days
    minMonthlySavings: 0.01, // Minimum savings to report
    oldSnapshotDays: 90,     // Snapshots older than N days
    minEBSVolumeGB: 1,       // Minimum volume size to report
  },
  analyzers: {
    cloudwatchLogs: true,    // Enable/disable specific analyzers
    kms: true,
    ec2: true,
    // ... etc
  },
};
```

## Output

The tool generates three outputs:

1. **Console Report**: Human-readable summary with top recommendations
2. **JSON Report**: `cost-optimization-report-YYYY-MM-DD.json` - Complete findings with metadata
3. **HTML Report**: `cost-optimization-report-YYYY-MM-DD.html` - HTML format

### Sample Console Output

```
╔═══════════════════════════════════════════════════════════════════════╗
║           AWS COST OPTIMIZATION REPORT                                ║
╚═══════════════════════════════════════════════════════════════════════╝

SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Findings: 45
Potential Monthly Savings: $234.56

Findings by Priority:
  🔴 High:   12
  🟡 Medium: 23
  🟢 Low:    10

TOP 10 RECOMMENDATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 🔴 [CloudWatch Logs] Log Group
   Resource: /aws/lambda/old-function
   Region: eu-central-1
   Issue: Inactive for 120 days
   💰 Savings: $15.50/month
   ✅ Action: Delete unused log group to save on storage costs
```

## AWS Permissions Required

The tool requires read-only permissions for:

- CloudWatch Logs: `logs:DescribeLogGroups`, `logs:DescribeLogStreams`
- CloudWatch Metrics: `cloudwatch:GetMetricStatistics`
- KMS: `kms:ListKeys`, `kms:DescribeKey`
- CloudTrail: `cloudtrail:LookupEvents`
- EC2: `ec2:DescribeVolumes`, `ec2:DescribeSnapshots`, `ec2:DescribeAddresses`, `ec2:DescribeInstances`
- S3: `s3:ListAllMyBuckets`, `s3:GetBucketLocation`, `s3:GetBucketLifecycleConfiguration`, `s3:GetBucketVersioning`, `s3:ListBucket`
- Lambda: `lambda:ListFunctions`, `lambda:GetFunction`
- RDS: `rds:DescribeDBInstances`, `rds:DescribeDBSnapshots`
- ELB: `elasticloadbalancing:DescribeLoadBalancers`, `elasticloadbalancing:DescribeTargetGroups`, `elasticloadbalancing:DescribeTargetHealth`

## Cost Estimates

All cost estimates are approximate and based on eu-central-1 pricing as of 2025. Actual costs may vary by:
- Region
- Volume/usage
- Reserved instances/savings plans
- AWS price changes

## Safety

This tool is **read-only** and makes no changes to your AWS resources. It only reads resource metadata and CloudWatch metrics to generate recommendations.

## Tips

1. **Run Regularly**: Schedule monthly runs to catch new optimization opportunities
2. **Review Findings**: Not all recommendations may apply to your use case - review carefully
3. **Start with High Priority**: Focus on high-priority findings for maximum impact
4. **Test Changes**: Always test in non-production first
5. **Monitor After Changes**: Verify savings with AWS Cost Explorer

## Example Workflow

1. Run the analyzer: `bun run cost-analyzer`
2. Review the console output for quick wins
3. Open the JSON report for detailed analysis
4. Import CSV into spreadsheet for tracking
5. Implement recommendations (manually or via AWS CLI)
6. Monitor cost changes in AWS Cost Explorer

## Extending the Tool

To add a new analyzer:

1. Create a new file in `cost-analyzer/analyzers/`
2. Implement the `Analyzer` interface
3. Add it to `cost-analyzer/index.ts`
4. Add configuration option in `config.ts`

## Troubleshooting

**"Access Denied" errors**: Ensure your AWS credentials have the required read permissions

**"Region not found" errors**: Check that the region is valid and available in your account

**Slow execution**: The tool queries many AWS APIs - execution time increases with more resources

**No findings**: Good news! Your account is already well-optimized, or resources are actively used

## License

Private project - not for distribution
