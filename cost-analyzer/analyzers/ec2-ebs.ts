import {
  EC2Client,
  DescribeVolumesCommand,
  DescribeSnapshotsCommand,
  DescribeAddressesCommand,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import type { Analyzer, AnalyzerConfig, AnalyzerResult, Finding } from "../types";
import {
  calculateEBSVolumeCost,
  calculateSnapshotCost,
  calculateEIPMonthlyCost,
} from "../utils/cost-calculator.js";

export class EC2EBSAnalyzer implements Analyzer {
  name = "EC2/EBS";

  async analyze(config: AnalyzerConfig): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const client = new EC2Client({ region: config.region });

    try {
      // Check unattached EBS volumes
      await this.checkUnattachedVolumes(client, config, findings);

      // Check old snapshots
      await this.checkOldSnapshots(client, config, findings);

      // Check unused Elastic IPs
      await this.checkUnusedElasticIPs(client, config, findings);

      // Check stopped instances (cost awareness)
      await this.checkStoppedInstances(client, config, findings);

      const totalPotentialSavings = findings.reduce(
        (sum, f) => sum + f.potentialMonthlySavings,
        0
      );

      return {
        analyzerName: this.name,
        region: config.region,
        findings,
        totalPotentialSavings,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        analyzerName: this.name,
        region: config.region,
        findings: [],
        totalPotentialSavings: 0,
        executionTimeMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async checkUnattachedVolumes(
    client: EC2Client,
    config: AnalyzerConfig,
    findings: Finding[]
  ): Promise<void> {
    try {
      const command = new DescribeVolumesCommand({
        Filters: [{ Name: "status", Values: ["available"] }],
      });
      const response = await client.send(command);

      if (response.Volumes) {
        for (const volume of response.Volumes) {
          const sizeGB = volume.Size || 0;
          const volumeType = volume.VolumeType || "gp2";
          const monthlyCost = calculateEBSVolumeCost(sizeGB, volumeType);

          if (sizeGB >= config.thresholds.minEBSVolumeGB) {
            findings.push({
              service: "EC2",
              resourceId: volume.VolumeId || "unknown",
              resourceType: "EBS Volume",
              region: config.region,
              issue: `Unattached ${volumeType} volume (${sizeGB} GB)`,
              recommendation: "Delete if no longer needed, or create snapshot and delete",
              estimatedMonthlyCost: monthlyCost,
              potentialMonthlySavings: monthlyCost,
              priority: monthlyCost > 5 ? "high" : monthlyCost > 1 ? "medium" : "low",
              metadata: {
                volumeId: volume.VolumeId,
                size: sizeGB,
                volumeType,
                createTime: volume.CreateTime?.toISOString(),
                availabilityZone: volume.AvailabilityZone,
              },
            });
          }
        }
      }
    } catch (error) {
      console.error("Error checking unattached volumes:", error);
    }
  }

  private async checkOldSnapshots(
    client: EC2Client,
    config: AnalyzerConfig,
    findings: Finding[]
  ): Promise<void> {
    try {
      const command = new DescribeSnapshotsCommand({
        OwnerIds: ["self"],
      });
      const response = await client.send(command);

      if (response.Snapshots) {
        const oldSnapshotThreshold =
          Date.now() - config.thresholds.oldSnapshotDays * 24 * 60 * 60 * 1000;

        for (const snapshot of response.Snapshots) {
          const startTime = snapshot.StartTime?.getTime();
          if (!startTime || startTime > oldSnapshotThreshold) continue;

          const sizeGB = snapshot.VolumeSize || 0;
          const monthlyCost = calculateSnapshotCost(sizeGB, false);
          const ageInDays = Math.floor((Date.now() - startTime) / (24 * 60 * 60 * 1000));

          findings.push({
            service: "EC2",
            resourceId: snapshot.SnapshotId || "unknown",
            resourceType: "EBS Snapshot",
            region: config.region,
            issue: `Old snapshot (${ageInDays} days, ${sizeGB} GB)`,
            recommendation: "Delete if no longer needed for backup or recovery",
            estimatedMonthlyCost: monthlyCost,
            potentialMonthlySavings: monthlyCost,
            priority: monthlyCost > 2 ? "medium" : "low",
            metadata: {
              snapshotId: snapshot.SnapshotId,
              volumeSize: sizeGB,
              startTime: snapshot.StartTime?.toISOString(),
              ageInDays,
              description: snapshot.Description,
            },
          });
        }
      }
    } catch (error) {
      console.error("Error checking old snapshots:", error);
    }
  }

  private async checkUnusedElasticIPs(
    client: EC2Client,
    config: AnalyzerConfig,
    findings: Finding[]
  ): Promise<void> {
    try {
      const command = new DescribeAddressesCommand({});
      const response = await client.send(command);

      if (response.Addresses) {
        for (const address of response.Addresses) {
          // EIP is unused if it's not associated with an instance or network interface
          if (!address.InstanceId && !address.NetworkInterfaceId) {
            const monthlyCost = calculateEIPMonthlyCost();

            findings.push({
              service: "EC2",
              resourceId: address.PublicIp || address.AllocationId || "unknown",
              resourceType: "Elastic IP",
              region: config.region,
              issue: "Unassociated Elastic IP (incurs charges)",
              recommendation: "Release if not needed, or associate with an instance",
              estimatedMonthlyCost: monthlyCost,
              potentialMonthlySavings: monthlyCost,
              priority: "medium",
              metadata: {
                allocationId: address.AllocationId,
                publicIp: address.PublicIp,
                domain: address.Domain,
              },
            });
          }
        }
      }
    } catch (error) {
      console.error("Error checking unused Elastic IPs:", error);
    }
  }

  private async checkStoppedInstances(
    client: EC2Client,
    config: AnalyzerConfig,
    findings: Finding[]
  ): Promise<void> {
    try {
      const command = new DescribeInstancesCommand({
        Filters: [{ Name: "instance-state-name", Values: ["stopped"] }],
      });
      const response = await client.send(command);

      if (response.Reservations) {
        for (const reservation of response.Reservations) {
          if (!reservation.Instances) continue;

          for (const instance of reservation.Instances) {
            const instanceId = instance.InstanceId || "unknown";
            const instanceType = instance.InstanceType || "unknown";

            // Calculate EBS volume costs for stopped instance
            let volumeCost = 0;
            if (instance.BlockDeviceMappings) {
              for (const device of instance.BlockDeviceMappings) {
                if (device.Ebs?.VolumeId) {
                  // Approximate: assume 8GB root volume + any additional
                  volumeCost += calculateEBSVolumeCost(8, "gp3");
                }
              }
            }

            findings.push({
              service: "EC2",
              resourceId: instanceId,
              resourceType: "EC2 Instance (Stopped)",
              region: config.region,
              issue: `Stopped instance still incurring EBS storage charges`,
              recommendation:
                "Terminate if no longer needed, or create AMI and terminate",
              estimatedMonthlyCost: volumeCost,
              potentialMonthlySavings: volumeCost,
              priority: "low",
              metadata: {
                instanceId,
                instanceType,
                launchTime: instance.LaunchTime?.toISOString(),
                name:
                  instance.Tags?.find((t) => t.Key === "Name")?.Value ||
                  "No name",
              },
            });
          }
        }
      }
    } catch (error) {
      console.error("Error checking stopped instances:", error);
    }
  }
}
