// ---------------------------------------------------------------------------
// Build, publish and deploy, in the shape the other Unisoft projects use.
//
// Same pattern as sveltelims: build the image, push it to registry.unisoft.no,
// then rewrite the image tag in the manifest repository and let ArgoCD notice.
// Deliberately the same, so that someone who knows one pipeline knows this one.
//
// Two differences, both on purpose:
//
//   - The tests run before anything is published. This project has a suite that
//     covers the access control in front of the record, and an image that
//     reaches a registry untested is one that can reach a cluster untested.
//   - Credentials go in through a git credential helper rather than into the
//     clone URL. A URL carrying a password ends up in the build log, in the
//     reflog and in `ps`, and no amount of URL-encoding changes that.
//
// The apus demo cluster is deployed separately by `deploy/apus/bygg.sh`, which
// builds with kaniko in-cluster and pins the tag in `deploy/apus/`. The two
// targets are independent; neither pipeline needs to know about the other.
//
// SET BEFORE FIRST USE: `K8S_REPO`, `K8S_YAML_PATH` and `K8S_YAML_FILES` below
// name a manifest repository that does not exist yet. EPJ has no manifests at
// git.unisoft.no - sveltelims-k8s, k8s-yaml and onering-yaml each hold their
// own project. Create the repository, or point these at wherever EPJ's
// manifests end up.
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
		APP_NAME = 'epj'

		DOCKER_REGISTRY = 'registry.unisoft.no'
		IMAGE_NAME = "library/${APP_NAME}"
		REGISTRY_CREDENTIALS = 'registry-unisoft-no-jenkins'

		// The manifest repository ArgoCD watches. See the note above: this one
		// does not exist yet.
		K8S_REPO = 'git.unisoft.no/Unisoft/epj-yaml.git'
		K8S_BRANCH = 'main'
		K8S_YAML_PATH = 'test/argocd'
		K8S_YAML_FILES = 'epj.yaml'
		K8S_CREDENTIALS = 'lars-git-unisoft-no'

		// Build number and commit, as the other projects tag. A branch build
		// carries its branch, so it can never be mistaken for a release.
		BRANCH_SUFFIX = "${env.BRANCH_NAME == 'main' || env.BRANCH_NAME == 'master' ? '' : '-' + (env.BRANCH_NAME ?: 'lokal').replaceAll('[^a-zA-Z0-9]', '-')}"
		IMAGE_TAG = "${env.BUILD_NUMBER}-${env.GIT_COMMIT?.take(7) ?: 'ukjent'}${BRANCH_SUFFIX}"

		// A test key, and meant to be one. Nothing here unlocks anything real.
		EPJ_DATA_KEY = 'ci-nokkel-kun-for-testkjoring-000000000'
		EPJ_ORG_HER_ID = '8000001'
		EPJ_ORG_NUMBER = '994598759'
		EPJ_INTEGRATION_MODE = 'mock'
		PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
		npm_config_cache = "${WORKSPACE}/.npm"
	}

	stages {
		stage('Checkout') {
			steps {
				checkout scm
				script {
					echo "Branch:  ${env.BRANCH_NAME}"
					echo "Commit:  ${env.GIT_COMMIT}"
					echo "Image:   ${DOCKER_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
				}
			}
		}

		// What fails most often, first.
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

		stage('Tests') {
			steps {
				script {
					// Postgres beside the tests, reachable under the name the
					// Woodpecker pipeline uses, so the connection string matches.
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

		stage('Build image') {
			steps {
				sh """
					docker build \
						-f docker/Dockerfile \
						--build-arg EPJ_VERSION=${IMAGE_TAG} \
						-t ${DOCKER_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG} \
						.
				"""
				script {
					// `latest` only from the main line. A branch build that claimed
					// it would be deployed by anything following the tag.
					if (env.BRANCH_NAME == 'main' || env.BRANCH_NAME == 'master') {
						sh "docker tag ${DOCKER_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG} ${DOCKER_REGISTRY}/${IMAGE_NAME}:latest"
					}
				}
			}
		}

		stage('Push image') {
			steps {
				script {
					docker.withRegistry("https://${DOCKER_REGISTRY}", "${REGISTRY_CREDENTIALS}") {
						sh "docker push ${DOCKER_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
						if (env.BRANCH_NAME == 'main' || env.BRANCH_NAME == 'master') {
							sh "docker push ${DOCKER_REGISTRY}/${IMAGE_NAME}:latest"
						}
					}
				}
			}
		}

		stage('Update manifest') {
			when {
				anyOf {
					branch 'main'
					branch 'master'
				}
			}
			steps {
				withCredentials([usernamePassword(
					credentialsId: "${K8S_CREDENTIALS}",
					usernameVariable: 'GIT_USERNAME',
					passwordVariable: 'GIT_PASSWORD'
				)]) {
					// Everything the script needs comes through the environment, so
					// nothing is interpolated into the shell by Groovy and no secret
					// is ever part of a command line.
					withEnv([
						"K8S_REPO=${K8S_REPO}",
						"K8S_BRANCH=${K8S_BRANCH}",
						"K8S_YAML_PATH=${K8S_YAML_PATH}",
						"K8S_YAML_FILES=${K8S_YAML_FILES}",
						"IMAGE_REF=${DOCKER_REGISTRY}/${IMAGE_NAME}",
						"NEW_TAG=${IMAGE_TAG}",
						"APP_NAME=${APP_NAME}",
						"BUILD_NUMBER=${env.BUILD_NUMBER}"
					]) {
						sh '''#!/bin/bash
							set -euo pipefail

							rm -rf manifester
							# The helper hands the credentials to git over a pipe. They
							# never appear in the URL, so they stay out of the log.
							git -c credential.helper= \
								-c credential.helper='!f() { echo "username=$GIT_USERNAME"; echo "password=$GIT_PASSWORD"; }; f' \
								clone --depth 1 --branch "$K8S_BRANCH" "https://$K8S_REPO" manifester

							cd "manifester/$K8S_YAML_PATH"
							git config user.email "jenkins@unisoft.no"
							git config user.name "Jenkins CI"

							for fil in $K8S_YAML_FILES; do
								if [ ! -f "$fil" ]; then
									echo "Fant ikke $fil i $K8S_YAML_PATH"
									exit 1
								fi
								if ! grep -q "image: $IMAGE_REF:" "$fil"; then
									echo "Fant ingen image-linje for $IMAGE_REF i $fil"
									exit 1
								fi
								sed -i "s|image: $IMAGE_REF:.*|image: $IMAGE_REF:$NEW_TAG|g" "$fil"
								git add "$fil"
							done

							if git diff --staged --quiet; then
								echo "Manifestet peker allerede på $NEW_TAG. Ingenting å gjøre."
							else
								git diff --staged
								git commit -m "Deploy $APP_NAME $NEW_TAG (bygg #$BUILD_NUMBER)"
								git -c credential.helper= \
									-c credential.helper='!f() { echo "username=$GIT_USERNAME"; echo "password=$GIT_PASSWORD"; }; f' \
									push origin "HEAD:$K8S_BRANCH"
							fi

							cd - > /dev/null
							rm -rf manifester
						'''
					}
				}
			}
		}
	}

	post {
		always {
			// The tag is unique per build, so nothing here is worth keeping.
			sh """
				docker rmi ${DOCKER_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG} || true
				docker rmi ${DOCKER_REGISTRY}/${IMAGE_NAME}:latest || true
			"""
			cleanWs()
		}
		success {
			script {
				echo "Publisert: ${DOCKER_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
				if (env.BRANCH_NAME == 'main' || env.BRANCH_NAME == 'master') {
					echo "Manifestet i ${K8S_REPO}/${K8S_YAML_PATH} er oppdatert. ArgoCD tar resten."
				} else {
					echo "Manifestet er ikke rørt - det skjer bare fra main/master."
				}
			}
		}
		failure {
			emailext(
				to: 'lars@roland.bz',
				subject: "[FAILURE] ${env.JOB_NAME} bygg #${env.BUILD_NUMBER}",
				body: "${env.BUILD_URL}\n\nGren: ${env.BRANCH_NAME ?: 'ukjent'}"
			)
		}
	}
}

// ---------------------------------------------------------------------------
// Notes
//
// NODE_TLS_REJECT_UNAUTHORIZED. The sveltelims pipeline sets this to '0' for
// the whole run. It is left out here on purpose: it turns off certificate
// verification for every Node process in the build, including npm's fetches. If
// something in this build fails on TLS, the fix belongs where the certificate
// is - the Docker daemon's config, or the agent's trust store - not in a switch
// that disables verification everywhere.
//
// End-to-end tests. Playwright is not run here; `.woodpecker.yaml` covers it.
// If Jenkins becomes the only pipeline, add a stage using the
// mcr.microsoft.com/playwright image with E2E_DATABASE_URL pointing at the same
// Postgres, gated on main/master so branch builds stay quick.
//
// Running on Kubernetes. If this Jenkins uses the Kubernetes plugin rather than
// Docker on the agent, replace `agent any` with a pod template, drop the
// `docker.image(...)` wrappers, and build with kaniko or buildkit instead of
// `docker build` - there is no Docker socket in a pod. `deploy/apus/bygg.sh`
// already does a kaniko build and is worth reading first.
// ---------------------------------------------------------------------------
