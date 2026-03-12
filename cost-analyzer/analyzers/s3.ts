import {
  S3Client,
  ListBucketsCommand,
  GetBucketLocationCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { Analyzer, AnalyzerConfig, AnalyzerResult, Finding } from "../types.js";
import { calculateS3StorageCost } from "../utils/cost-calculator.js";

export class S3Analyzer implements Analyzer {
  name = "S3";

  async analyze(config: AnalyzerConfig): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const client = new S3Client({ region: config.region });

    try {
      // List all buckets
      const listBucketsCommand = new ListBucketsCommand({});
      const bucketsResponse = await client.send(listBucketsCommand);

      if (bucketsResponse.Buckets) {
        for (const bucket of bucketsResponse.Buckets) {
          if (!bucket.Name) continue;

          try {
            // Get bucket location
            const locationCommand = new GetBucketLocationCommand({
              Bucket: bucket.Name,
            });
            const locationResponse = await client.send(locationCommand);
            const bucketRegion = locationResponse.LocationConstraint || "us-east-1";

            // Only analyze buckets in the current region
            if (bucketRegion !== config.region) continue;

            // Check for lifecycle policy
            await this.checkLifecyclePolicy(client, bucket.Name, config, findings);

            // Check for versioning without lifecycle
            await this.checkVersioning(client, bucket.Name, config, findings);

            // Check bucket size (approximate)
            await this.checkBucketSize(client, bucket.Name, config, findings);
          } catch (error) {
            // Bucket might not be accessible or in different region
            console.error(`Error analyzing bucket ${bucket.Name}:`, error);
          }
        }
      }

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

  private async checkLifecyclePolicy(
    client: S3Client,
    bucketName: string,
    config: AnalyzerConfig,
    findings: Finding[]
  ): Promise<void> {
    try {
      const command = new GetBucketLifecycleConfigurationCommand({
        Bucket: bucketName,
      });

      try {
        await client.send(command);
        // Bucket has lifecycle policy - that's good
      } catch (error: any) {
        if (error.name === "NoSuchLifecycleConfiguration") {
          // No lifecycle policy set
          findings.push({
            service: "S3",
            resourceId: bucketName,
            resourceType: "S3 Bucket",
            region: config.region,
            issue: "No lifecycle policy configured",
            recommendation:
              "Configure lifecycle rules to transition old data to cheaper storage classes (IA, Glacier) or delete after retention period",
            estimatedMonthlyCost: 0, // We don't know the size yet
            potentialMonthlySavings: 0, // Conservative estimate
            priority: "medium",
            metadata: {
              bucketName,
            },
          });
        }
      }
    } catch (error) {
      console.error(`Error checking lifecycle policy for ${bucketName}:`, error);
    }
  }

  private async checkVersioning(
    client: S3Client,
    bucketName: string,
    config: AnalyzerConfig,
    findings: Finding[]
  ): Promise<void> {
    try {
      const versioningCommand = new GetBucketVersioningCommand({
        Bucket: bucketName,
      });
      const versioningResponse = await client.send(versioningCommand);

      if (versioningResponse.Status === "Enabled") {
        // Check if there's a lifecycle policy to clean up old versions
        try {
          const lifecycleCommand = new GetBucketLifecycleConfigurationCommand({
            Bucket: bucketName,
          });
          const lifecycleResponse = await client.send(lifecycleCommand);

          // Check if any rule handles noncurrent versions
          const hasNoncurrentVersionRule = lifecycleResponse.Rules?.some(
            (rule) =>
              rule.NoncurrentVersionExpiration || rule.NoncurrentVersionTransitions
          );

          if (!hasNoncurrentVersionRule) {
            findings.push({
              service: "S3",
              resourceId: bucketName,
              resourceType: "S3 Bucket",
              region: config.region,
              issue: "Versioning enabled but no lifecycle rule for old versions",
              recommendation:
                "Add lifecycle rule to expire or transition noncurrent versions after N days",
              estimatedMonthlyCost: 0,
              potentialMonthlySavings: 0,
              priority: "medium",
              metadata: {
                bucketName,
                versioningStatus: versioningResponse.Status,
              },
            });
          }
        } catch (error: any) {
          if (error.name === "NoSuchLifecycleConfiguration") {
            findings.push({
              service: "S3",
              resourceId: bucketName,
              resourceType: "S3 Bucket",
              region: config.region,
              issue: "Versioning enabled but no lifecycle policy",
              recommendation:
                "Add lifecycle rule to expire or transition noncurrent versions after N days",
              estimatedMonthlyCost: 0,
              potentialMonthlySavings: 0,
              priority: "high",
              metadata: {
                bucketName,
                versioningStatus: versioningResponse.Status,
              },
            });
          }
        }
      }
    } catch (error) {
      console.error(`Error checking versioning for ${bucketName}:`, error);
    }
  }

  private async checkBucketSize(
    client: S3Client,
    bucketName: string,
    config: AnalyzerConfig,
    findings: Finding[]
  ): Promise<void> {
    try {
      // Sample the bucket to estimate size (only check first 1000 objects)
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        MaxKeys: 1000,
      });
      const response = await client.send(command);

      if (response.Contents && response.Contents.length > 0) {
        const totalSize = response.Contents.reduce(
          (sum, obj) => sum + (obj.Size || 0),
          0
        );
        const sizeGB = totalSize / (1024 * 1024 * 1024);

        // If bucket has more objects, this is just a sample
        const isSample = response.IsTruncated;

        if (sizeGB > 100 || (isSample && sizeGB > 10)) {
          const estimatedMonthlyCost = calculateS3StorageCost(sizeGB);

          // Check if objects are old and could be moved to cheaper storage
          const oldObjects = response.Contents.filter((obj) => {
            const lastModified = obj.LastModified?.getTime();
            if (!lastModified) return false;
            const ageInDays =
              (Date.now() - lastModified) / (24 * 60 * 60 * 1000);
            return ageInDays > 90;
          });

          if (oldObjects.length > response.Contents.length * 0.3) {
            findings.push({
              service: "S3",
              resourceId: bucketName,
              resourceType: "S3 Bucket",
              region: config.region,
              issue: `Large bucket with old objects (sampled ${sizeGB.toFixed(2)} GB${isSample ? "+" : ""})`,
              recommendation:
                "Consider moving objects older than 90 days to S3 Intelligent-Tiering or Glacier",
              estimatedMonthlyCost,
              potentialMonthlySavings: estimatedMonthlyCost * 0.4, // ~40% savings with IA/Glacier
              priority: estimatedMonthlyCost > 10 ? "high" : "medium",
              metadata: {
                bucketName,
                sampledSizeGB: sizeGB.toFixed(2),
                isSample,
                totalObjectsSampled: response.Contents.length,
                oldObjectsPercent: Math.round(
                  (oldObjects.length / response.Contents.length) * 100
                ),
              },
            });
          }
        }
      }
    } catch (error) {
      console.error(`Error checking bucket size for ${bucketName}:`, error);
    }
  }
}
