/**
 * AWS pricing estimates (as of 2025, prices vary by region)
 * These are approximate prices for eu-central-1 region
 */

export const PRICING = {
  // CloudWatch Logs - per GB
  CLOUDWATCH_LOGS_INGESTION_PER_GB: 0.50,
  CLOUDWATCH_LOGS_STORAGE_PER_GB: 0.033, // per month

  // KMS - per key per month
  KMS_CUSTOMER_MANAGED_KEY: 1.00,

  // EC2
  EC2_EIP_IDLE: 0.005, // per hour when not attached
  EBS_GP3_PER_GB: 0.088, // per month
  EBS_GP2_PER_GB: 0.10, // per month
  EBS_IO1_PER_GB: 0.125, // per month
  EBS_SNAPSHOT_PER_GB: 0.05, // per month

  // RDS
  RDS_SNAPSHOT_PER_GB: 0.095, // per month

  // S3
  S3_STANDARD_PER_GB: 0.023, // per month
  S3_INTELLIGENT_TIERING_PER_GB: 0.0125, // per month (avg)

  // Load Balancers
  ALB_PER_HOUR: 0.0225,
  NLB_PER_HOUR: 0.0225,
  CLB_PER_HOUR: 0.025,

  // NAT Gateway
  NAT_GATEWAY_PER_HOUR: 0.045,
};

export function calculateCloudWatchLogsStorageCost(sizeGB: number): number {
  return sizeGB * PRICING.CLOUDWATCH_LOGS_STORAGE_PER_GB;
}

export function calculateKMSKeyCost(numKeys: number): number {
  return numKeys * PRICING.KMS_CUSTOMER_MANAGED_KEY;
}

export function calculateEIPIdleCost(hoursIdle: number): number {
  return hoursIdle * PRICING.EC2_EIP_IDLE;
}

export function calculateEIPMonthlyCost(): number {
  return 30 * 24 * PRICING.EC2_EIP_IDLE; // ~$3.60/month
}

export function calculateEBSVolumeCost(sizeGB: number, volumeType: string): number {
  const pricePerGB = volumeType === "gp3"
    ? PRICING.EBS_GP3_PER_GB
    : volumeType === "gp2"
    ? PRICING.EBS_GP2_PER_GB
    : PRICING.EBS_IO1_PER_GB;

  return sizeGB * pricePerGB;
}

export function calculateSnapshotCost(sizeGB: number, isRDS: boolean = false): number {
  const pricePerGB = isRDS ? PRICING.RDS_SNAPSHOT_PER_GB : PRICING.EBS_SNAPSHOT_PER_GB;
  return sizeGB * pricePerGB;
}

export function calculateS3StorageCost(sizeGB: number): number {
  return sizeGB * PRICING.S3_STANDARD_PER_GB;
}

export function calculateLoadBalancerMonthlyCost(type: "ALB" | "NLB" | "CLB"): number {
  const hourlyRate = type === "CLB"
    ? PRICING.CLB_PER_HOUR
    : type === "ALB"
    ? PRICING.ALB_PER_HOUR
    : PRICING.NLB_PER_HOUR;

  return 30 * 24 * hourlyRate; // ~$16-18/month
}

export function calculateNATGatewayMonthlyCost(): number {
  return 30 * 24 * PRICING.NAT_GATEWAY_PER_HOUR; // ~$32.40/month
}

export function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function formatStorageSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}
