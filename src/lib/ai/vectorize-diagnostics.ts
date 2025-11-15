/**
 * Diagnostic script to check Vectorize setup and debug incomplete results
 * 
 * Run this to validate:
 * 1. Vectorize index is accessible
 * 2. Dimensions match between indexing and querying
 * 3. Metadata contains text field
 * 4. Namespaces have vectors
 * 
 * Usage: Add this as a tRPC endpoint or run via API route
 */

import { db } from "@/db";
import { agent, knowledgeSource } from "@/db/schema";
import { checkVectorizeHealth, listNamespaceVectors, testVectorizeQuery } from "@/lib/ai/vectorize-utils";
import { eq } from "drizzle-orm";

export async function runVectorizeDiagnostics(agentId: string) {
	console.log("=".repeat(80));
	console.log("VECTORIZE DIAGNOSTICS STARTING");
	console.log("=".repeat(80));

	const diagnostics: any = {
		timestamp: new Date().toISOString(),
		agentId,
		steps: [],
	};

	try {
		// Step 1: Check Vectorize health
		console.log("\n[Step 1] Checking Vectorize index health...");
		const health = await checkVectorizeHealth();
		diagnostics.steps.push({
			step: "health_check",
			result: health,
		});
		
		if (health.status === "error") {
			console.error("❌ Vectorize is not accessible!");
			return diagnostics;
		}
		
		console.log("✅ Vectorize is healthy");
		console.log(`   Dimensions: ${health.dimensions}`);
		console.log(`   Vector Count: ${health.vectorCount}`);

		// Step 2: Check agent exists
		console.log("\n[Step 2] Checking agent...");
		const [agentData] = await db
			.select()
			.from(agent)
			.where(eq(agent.id, agentId))
			.limit(1);
		
		if (!agentData) {
			console.error(`❌ Agent ${agentId} not found`);
			diagnostics.steps.push({
				step: "agent_check",
				result: { status: "error", message: "Agent not found" },
			});
			return diagnostics;
		}
		
		console.log(`✅ Agent found: ${agentData.name} (${agentData.slug})`);
		diagnostics.steps.push({
			step: "agent_check",
			result: { status: "success", agent: agentData },
		});

		// Step 3: Check knowledge sources
		console.log("\n[Step 3] Checking knowledge sources...");
		const sources = await db
			.select()
			.from(knowledgeSource)
			.where(eq(knowledgeSource.agentId, agentId))
			.limit(10);
		
		console.log(`   Found ${sources.length} knowledge sources`);
		
		const indexed = sources.filter(s => s.status === "indexed");
		const failed = sources.filter(s => s.status === "failed");
		
		console.log(`   Indexed: ${indexed.length}, Failed: ${failed.length}`);
		
		if (indexed.length === 0) {
			console.warn("⚠️  No indexed knowledge sources! Upload and index content first.");
		}
		
		diagnostics.steps.push({
			step: "knowledge_sources",
			result: {
				total: sources.length,
				indexed: indexed.length,
				failed: failed.length,
				sources: sources.map(s => ({
					id: s.id,
					fileName: s.fileName,
					status: s.status,
					vectorizeIdsCount: s.vectorizeIds?.length || 0,
				})),
			},
		});

		// Step 4: List vectors in namespace
		console.log("\n[Step 4] Listing vectors in namespace...");
		const vectorList = await listNamespaceVectors(agentId, 5);
		
		if (vectorList.status === "error") {
			console.error("❌ Failed to list vectors:", vectorList.message);
		} else {
			console.log(`   Found ${vectorList.count} vectors in namespace ${agentId}`);
			
			if (vectorList.count === 0) {
				console.warn("⚠️  Namespace is EMPTY! No vectors indexed yet.");
			} else {
				console.log("   Sample vectors:");
				vectorList.vectors?.forEach((v, idx) => {
					console.log(`     ${idx + 1}. ID: ${v.id}`);
					console.log(`        Has Text: ${v.hasText ? "✅" : "❌"}`);
					console.log(`        Text Length: ${v.textLength} bytes`);
					console.log(`        Source: ${v.fileName || "Unknown"}`);
				});
			}
		}
		
		diagnostics.steps.push({
			step: "list_vectors",
			result: vectorList,
		});

		// Step 5: Test query
		console.log("\n[Step 5] Testing sample query...");
		const testQuery = "implementation plan";
		const testResult = await testVectorizeQuery(agentId, testQuery);
		
		if (testResult.status === "error") {
			console.error("❌ Test query failed:", testResult.message);
		} else {
			console.log(`   Query: "${testQuery}"`);
			console.log(`   Results: ${testResult.resultsCount}`);
			
			if (testResult.resultsCount === 0) {
				console.warn("⚠️  No results returned! Check if vectors are indexed.");
			} else if (testResult.sampleMatch) {
				console.log("   Sample match:");
				console.log(`     Score: ${testResult.sampleMatch.score.toFixed(3)}`);
				console.log(`     Has Text: ${testResult.sampleMatch.hasText ? "✅" : "❌"}`);
				console.log(`     Metadata Keys: ${testResult.sampleMatch.metadataKeys.join(", ")}`);
				console.log(`     Text Preview: "${testResult.sampleMatch.textPreview}"`);
			}
		}
		
		diagnostics.steps.push({
			step: "test_query",
			result: testResult,
		});

		// Final summary
		console.log("\n" + "=".repeat(80));
		console.log("DIAGNOSTICS SUMMARY");
		console.log("=".repeat(80));
		
		const issues: string[] = [];
		
		if (health.status === "error") issues.push("Vectorize not accessible");
		if (health.dimensions !== 1536) issues.push(`Unexpected dimensions: ${health.dimensions} (expected 1536)`);
		if (indexed.length === 0) issues.push("No indexed content");
		if (vectorList.count === 0) issues.push("Namespace empty");
		if (testResult.resultsCount === 0) issues.push("Test query returned no results");
		if (testResult.sampleMatch && !testResult.sampleMatch.hasText) issues.push("Vectors missing text metadata");
		
		if (issues.length === 0) {
			console.log("✅ All checks passed! Vectorize setup looks good.");
		} else {
			console.log("⚠️  Issues detected:");
			issues.forEach((issue, idx) => {
				console.log(`   ${idx + 1}. ${issue}`);
			});
		}
		
		diagnostics.summary = {
			status: issues.length === 0 ? "healthy" : "issues_found",
			issues,
		};

		console.log("=".repeat(80));
		
		return diagnostics;
		
	} catch (error) {
		console.error("\n❌ Diagnostics failed with error:", error);
		diagnostics.error = error instanceof Error ? error.message : String(error);
		return diagnostics;
	}
}
