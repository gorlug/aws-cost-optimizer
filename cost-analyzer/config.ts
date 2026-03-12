export interface Config {
  regions: string[];
  thresholds: {
    inactiveDays: number;
    minMonthlySavings: number;
    oldSnapshotDays: number;
    minEBSVolumeGB: number;
  };
  analyzers: {
    cloudwatchLogs: boolean;
    cloudwatchMetrics: boolean;
    kms: boolean;
    ec2: boolean;
    ebs: boolean;
    s3: boolean;
    lambda: boolean;
    rds: boolean;
    elb: boolean;
    dynamodb: boolean;
  };
}

export const DEFAULT_CONFIG: Config = {
  regions: ["eu-central-1", 'us-east-1'], // Add more regions as needed
  thresholds: {
    inactiveDays: 90, // Resources inactive for 90+ days
    minMonthlySavings: 0.01, // Report findings with at least $0.01 savings
    oldSnapshotDays: 90, // Snapshots older than 90 days
    minEBSVolumeGB: 1, // Minimum EBS volume size to report
  },
  analyzers: {
    cloudwatchLogs: true,
    cloudwatchMetrics: true,
    kms: true,
    ec2: true,
    ebs: true,
    s3: true,
    lambda: true,
    rds: true,
    elb: true,
    dynamodb: true,
  },
};

export function loadConfig(): Config {
  // In the future, this could load from a config file or environment variables
  return DEFAULT_CONFIG;
}
