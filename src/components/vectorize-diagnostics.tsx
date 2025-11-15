/**
 * Example component to run Vectorize diagnostics from your UI
 * Add this to your agent management page or settings panel
 */

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/integrations/trpc/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

interface VectorizeDiagnosticsProps {
	agentId: string;
}

export function VectorizeDiagnostics({ agentId }: VectorizeDiagnosticsProps) {
	const [isOpen, setIsOpen] = useState(false);
	const trpc = useTRPC();
	
	const runDiagnostics = useMutation(
		trpc.agent.runVectorizeDiagnostics.mutationOptions({
			onSuccess: (data: any) => {
				console.log("Diagnostics completed:", data);
			},
			onError: (error: any) => {
				console.error("Diagnostics failed:", error);
			},
		})
	);

	const handleRunDiagnostics = () => {
		runDiagnostics.mutate({ agentId });
	};

	const diagnostics = runDiagnostics.data;
	const hasIssues = diagnostics?.summary?.issues && diagnostics.summary.issues.length > 0;

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Button
					onClick={handleRunDiagnostics}
					disabled={runDiagnostics.isPending}
					variant="outline"
				>
					{runDiagnostics.isPending ? "Running..." : "Run Vectorize Diagnostics"}
				</Button>
				
				{diagnostics && (
					<Button
						onClick={() => setIsOpen(!isOpen)}
						variant="ghost"
						size="sm"
					>
						{isOpen ? "Hide Details" : "Show Details"}
					</Button>
				)}
			</div>

			{diagnostics && (
				<>
					{/* Summary Alert */}
					<Alert variant={hasIssues ? "destructive" : "default"}>
						<AlertTitle>
							{hasIssues ? "⚠️ Issues Detected" : "✅ All Checks Passed"}
						</AlertTitle>
						<AlertDescription>
							{hasIssues ? (
								<ul className="list-disc list-inside space-y-1 mt-2">
									{diagnostics.summary.issues.map((issue: string, idx: number) => (
										<li key={idx}>{issue}</li>
									))}
								</ul>
							) : (
								<p>Vectorize is configured correctly and returning results.</p>
							)}
						</AlertDescription>
					</Alert>

					{/* Detailed Results */}
					{isOpen && (
						<div className="border rounded-lg p-4 space-y-4 bg-muted/50">
							<h3 className="font-semibold">Diagnostic Details</h3>
							
							{/* Health Check */}
							{diagnostics.steps.find((s: any) => s.step === "health_check") && (
								<div>
									<h4 className="text-sm font-medium mb-2">Vectorize Health</h4>
									<pre className="text-xs bg-background p-2 rounded overflow-x-auto">
										{JSON.stringify(
											diagnostics.steps.find((s: any) => s.step === "health_check")?.result,
											null,
											2
										)}
									</pre>
								</div>
							)}

							{/* Knowledge Sources */}
							{diagnostics.steps.find((s: any) => s.step === "knowledge_sources") && (
								<div>
									<h4 className="text-sm font-medium mb-2">Knowledge Sources</h4>
									<pre className="text-xs bg-background p-2 rounded overflow-x-auto">
										{JSON.stringify(
											diagnostics.steps.find((s: any) => s.step === "knowledge_sources")?.result,
											null,
											2
										)}
									</pre>
								</div>
							)}

							{/* Test Query */}
							{diagnostics.steps.find((s: any) => s.step === "test_query") && (
								<div>
									<h4 className="text-sm font-medium mb-2">Test Query Results</h4>
									<pre className="text-xs bg-background p-2 rounded overflow-x-auto">
										{JSON.stringify(
											diagnostics.steps.find((s: any) => s.step === "test_query")?.result,
											null,
											2
										)}
									</pre>
								</div>
							)}

							{/* Full JSON */}
							<details>
								<summary className="text-sm font-medium cursor-pointer">
									Full Diagnostics JSON
								</summary>
								<pre className="text-xs bg-background p-2 rounded overflow-x-auto mt-2">
									{JSON.stringify(diagnostics, null, 2)}
								</pre>
							</details>
						</div>
					)}
				</>
			)}
		</div>
	);
}

/**
 * Usage example in your agent details page:
 * 
 * import { VectorizeDiagnostics } from "@/components/vectorize-diagnostics";
 * 
 * function AgentDetailsPage({ agentId }) {
 *   return (
 *     <div>
 *       <h1>Agent Details</h1>
 *       
 *       {/* Your other agent management UI *\/}
 *       
 *       <section>
 *         <h2>RAG Diagnostics</h2>
 *         <VectorizeDiagnostics agentId={agentId} />
 *       </section>
 *     </div>
 *   );
 * }
 */
