import { KMSClient, ListKeysCommand, DescribeKeyCommand } from "@aws-sdk/client-kms";
import {
  CloudTrailClient,
  LookupEventsCommand,
} from "@aws-sdk/client-cloudtrail";
import type { Analyzer, AnalyzerConfig, AnalyzerResult, Finding } from "../types.js";
import { calculateKMSKeyCost } from "../utils/cost-calculator.js";

export class KMSAnalyzer implements Analyzer {
  name = "KMS";

  async analyze(config: AnalyzerConfig): Promise<AnalyzerResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const kmsClient = new KMSClient({ region: config.region });
    const cloudTrailClient = new CloudTrailClient({ region: config.region });

    try {
      const inactiveThreshold = new Date(
        Date.now() - config.thresholds.inactiveDays * 24 * 60 * 60 * 1000
      );
      let nextMarker: string | undefined;

      do {
        const command = new ListKeysCommand({ Marker: nextMarker });
        const response = await kmsClient.send(command);

        if (response.Keys) {
          for (const key of response.Keys) {
            if (!key.KeyId) continue;

            try {
              // Get key details
              const describeCommand = new DescribeKeyCommand({ KeyId: key.KeyId });
              const describeResponse = await kmsClient.send(describeCommand);
              const keyMetadata = describeResponse.KeyMetadata;

              if (!keyMetadata) continue;

              // Only check customer-managed keys (not AWS-managed)
              if (keyMetadata.KeyManager !== "CUSTOMER") continue;

              // Skip keys that are pending deletion or disabled
              if (
                keyMetadata.KeyState === "PendingDeletion" ||
                keyMetadata.KeyState === "Disabled"
              ) {
                continue;
              }

              const monthlyCost = calculateKMSKeyCost(1);

              // Check key usage via CloudTrail
              try {
                const lookupCommand = new LookupEventsCommand({
                  LookupAttributes: [
                    {
                      AttributeKey: "ResourceName",
                      AttributeValue: keyMetadata.Arn,
                    },
                  ],
                  StartTime: inactiveThreshold,
                  EndTime: new Date(),
                  MaxResults: 1,
                });

                const eventsResponse = await cloudTrailClient.send(lookupCommand);
                const hasRecentActivity = (eventsResponse.Events?.length || 0) > 0;

                if (!hasRecentActivity) {
                  const keyAge = keyMetadata.CreationDate
                    ? Math.floor(
                        (Date.now() - keyMetadata.CreationDate.getTime()) /
                          (24 * 60 * 60 * 1000)
                      )
                    : null;

                  findings.push({
                    service: "KMS",
                    resourceId: keyMetadata.KeyId ?? '',
                    resourceType: "Customer Managed Key",
                    region: config.region,
                    issue: `No usage detected in the last ${config.thresholds.inactiveDays} days`,
                    recommendation:
                      "Schedule key for deletion if no longer needed (30-day waiting period)",
                    estimatedMonthlyCost: monthlyCost,
                    potentialMonthlySavings: monthlyCost,
                    priority: "medium",
                    metadata: {
                      keyId: keyMetadata.KeyId,
                      description: keyMetadata.Description,
                      creationDate: keyMetadata.CreationDate?.toISOString(),
                      keyAge,
                      keyState: keyMetadata.KeyState,
                    },
                  });
                }
              } catch (cloudTrailError) {
                // CloudTrail might not be available or accessible
                // Still report the key but with lower priority
                findings.push({
                  service: "KMS",
                  resourceId: keyMetadata.KeyId ?? '',
                  resourceType: "Customer Managed Key",
                  region: config.region,
                  issue: "Unable to verify recent usage (CloudTrail not accessible)",
                  recommendation:
                    "Manually verify if key is still needed, consider scheduling for deletion",
                  estimatedMonthlyCost: monthlyCost,
                  potentialMonthlySavings: monthlyCost,
                  priority: "low",
                  metadata: {
                    keyId: keyMetadata.KeyId,
                    description: keyMetadata.Description,
                    creationDate: keyMetadata.CreationDate?.toISOString(),
                    keyState: keyMetadata.KeyState,
                  },
                });
              }
            } catch (error) {
              console.error(`Error analyzing KMS key ${key.KeyId}:`, error);
            }
          }
        }

        nextMarker = response.NextMarker;
      } while (nextMarker);

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
}
