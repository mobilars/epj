// ---------------------------------------------------------------------------
// Continuous integration for Jenkins.
//
// Mirrors `.woodpecker.yaml` deliberately: the same stages, the same order and
// the same reasoning. Two pipelines that test the same thing differently are
// two pipelines that disagree, and the one nobody watches is the one that rots.
//
// The order puts what fails most often first: the types, then the unit tests,
// then the browser.
//
// This pipeline does NOT build the container image, for the reason given in
// `.woodpecker.yaml`: a kaniko build of this project needs around 3.5 GB, the
// cluster nodes have under 4 GB, and they are also running the thing being
// tested. The image is built and pushed by `deploy/apus/bygg.sh`, which runs
// the build to completion and cleans up after itself.
//
// AGENT MODEL. This file uses Docker on the agent, which is the portable
// choice. If your Jenkins runs inside the cluster with the Kubernetes plugin,
// replace the `agent` block with a pod template instead - see the note at the
// foot of this file. Nothing else changes.
// ---------------------------------------------------------------------------

pipeline {
	agent any

	options {
		timestamps()
		buildDiscarder(logRotator(numToKeepStr: '20'))
		timeout(time: 45, unit: 'MINUTES')
		disableConcurrentBuilds()
	}

	environment {
		// A test key, and meant to be one. Nothing here unlocks anything real.
		EPJ_DATA_KEY = 'ci-nokkel-kun-for-testkjoring-000000000'
		EPJ_ORG_HER_ID = '8000001'
		EPJ_ORG_NUMBER = '994598759'
		EPJ_INTEGRATION_MODE = 'mock'
		// Playwright's browsers are downloaded only in the stage that uses them.
		PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
		// npm writes its cache under the workspace, so the agent needs no home.
		npm_config_cache = "${WORKSPACE}/.npm"
	}

	stages {
		stage('Types and build') {
			agent {
				docker {
					image 'node:22-alpine'
					reuseNode true
				}
			}
			steps {
				sh 'npm ci'
				sh 'npm run check'
				sh 'npm run build'
			}
		}

		stage('Unit tests') {
			steps {
				script {
					// Postgres runs beside the tests and is reachable as `postgres`,
					// so the connection string is the same one Woodpecker uses.
					docker.image('postgres:16-alpine').withRun(
						'-e POSTGRES_USER=epj -e POSTGRES_PASSWORD=epj -e POSTGRES_DB=epj'
					) { db ->
						docker.image('node:22-alpine').inside("--link ${db.id}:postgres") {
							sh 'npm ci'
							sh 'until nc -z postgres 5432; do sleep 1; done'
							withEnv(['EPJ_TEST_DATABASE_URL=postgres://epj:epj@postgres:5432/postgres']) {
								sh 'npm test'
							}
						}
					}
				}
			}
		}

		stage('End to end') {
			steps {
				script {
					docker.image('postgres:16-alpine').withRun(
						'-e POSTGRES_USER=epj -e POSTGRES_PASSWORD=epj -e POSTGRES_DB=epj'
					) { db ->
						docker.image('mcr.microsoft.com/playwright:v1.63.0-noble').inside("--link ${db.id}:postgres") {
							sh 'npm ci'
							sh 'until nc -z postgres 5432; do sleep 1; done'
							withEnv([
								'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0',
								'EPJ_BASE_URL=http://127.0.0.1:4173',
								'E2E_DATABASE_URL=postgres://epj:epj@postgres:5432/epj_e2e'
							]) {
								sh 'npx playwright test'
							}
						}
					}
				}
			}
			post {
				always {
					archiveArtifacts artifacts: 'playwright-report/**, test-results/**',
						allowEmptyArchive: true, fingerprint: false
				}
			}
		}
	}

	post {
		failure {
			// Same recipient and relay as the Woodpecker pipeline. The SMTP
			// password belongs in Jenkins' credential store, never in this file.
			emailext(
				to: 'lars@roland.bz',
				subject: "[FAILURE] ${env.JOB_NAME} build #${env.BUILD_NUMBER}",
				body: "${env.BUILD_URL}\n\nBranch: ${env.BRANCH_NAME ?: 'ukjent'}"
			)
		}
	}
}

// ---------------------------------------------------------------------------
// Running on Kubernetes instead
//
// With the Kubernetes plugin, swap `agent any` for a pod template and drop the
// per-stage `docker.image(...)` wrappers - the containers below take their
// place, and Postgres becomes a sidecar reachable on localhost:
//
//   agent {
//     kubernetes {
//       yaml '''
//         spec:
//           containers:
//             - name: node
//               image: node:22-alpine
//               command: ['cat']
//               tty: true
//               resources:
//                 requests: {cpu: 250m, memory: 512Mi}
//                 limits: {cpu: '1', memory: 1536Mi}
//             - name: postgres
//               image: postgres:16-alpine
//               env:
//                 - {name: POSTGRES_USER, value: epj}
//                 - {name: POSTGRES_PASSWORD, value: epj}
//                 - {name: POSTGRES_DB, value: epj}
//               resources:
//                 requests: {cpu: 100m, memory: 128Mi}
//                 limits: {cpu: 500m, memory: 512Mi}
//       '''
//     }
//   }
//
// Then each stage runs `container('node') { ... }`, and the database URL
// becomes postgres://epj:epj@127.0.0.1:5432/postgres, since containers in a pod
// share a network namespace.
//
// Set resource limits either way. Without them nothing stops a build step from
// taking down the node it runs on, and with it the rest of the cluster.
// ---------------------------------------------------------------------------
