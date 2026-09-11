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
// SET BEFORE THE MANIFEST STAGE CAN WORK: `K8S_REPO`, `K8S_YAML_PATH` and
// `K8S_YAML_FILES` name a manifest repository that does not exist yet. EPJ has
// no manifests at git.unisoft.no - sveltelims-k8s, k8s-yaml and onering-yaml
// each hold their own project. Create the repository, or point these at
// wherever EPJ's manifests end up. Everything before that stage works without.
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

		/*
		 * Fully qualified, and used through plain `docker run` rather than the
		 * Docker Pipeline plugin's `agent { docker { ... } }`.
		 *
		 * This Jenkins has registry.unisoft.no configured as its global registry,
		 * so the plugin prefixes every image it starts with it: asking for
		 * `node:22-alpine` made it pull `registry.unisoft.no/node:22-alpine`,
		 * which Harbor refuses as a repository name with no project. Naming the
		 * host here says where these come from and leaves no room for a prefix.
		 */
		NODE_IMAGE = 'docker.io/library/node:22-alpine'
		POSTGRES_IMAGE = 'docker.io/library/postgres:16-alpine'

		// The manifest repository ArgoCD watches. See the note above: this one
		// does not exist yet.
		K8S_REPO = 'git.unisoft.no/Unisoft/epj-yaml.git'
		K8S_BRANCH = 'main'
		K8S_YAML_PATH = 'test/argocd'
		K8S_YAML_FILES = 'epj.yaml'
		K8S_CREDENTIALS = 'lars-git-unisoft-no'

		// A test key, and meant to be one. Nothing here unlocks anything real.
		EPJ_DATA_KEY = 'ci-nokkel-kun-for-testkjoring-000000000'
		EPJ_ORG_HER_ID = '8000001'
		EPJ_ORG_NUMBER = '994598759'
		EPJ_INTEGRATION_MODE = 'mock'
		PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
	}

	stages {
		stage('Checkout') {
			steps {
				checkout scm
				script {
					/*
					 * Which branch this is, in a job of either kind.
					 *
					 * A multibranch job sets BRANCH_NAME; a plain pipeline job does
					 * not, and leaves it null - which silently turned every
					 * `when { branch 'master' }` false, so a build could go green
					 * having published nothing. The git plugin's GIT_BRANCH is the
					 * fallback, and it arrives as `origin/master`.
					 */
					env.EPJ_BRANCH = env.BRANCH_NAME ?: (env.GIT_BRANCH ?: '').replaceFirst(/^origin\//, '')
					if (!env.EPJ_BRANCH) {
						env.EPJ_BRANCH = sh(script: 'git rev-parse --abbrev-ref HEAD', returnStdout: true).trim()
					}
					env.EPJ_IS_MAIN = (env.EPJ_BRANCH in ['main', 'master']) ? 'true' : 'false'

					// A branch build carries its branch, so it can never be mistaken
					// for a release.
					def suffix = env.EPJ_IS_MAIN == 'true' ? '' : '-' + env.EPJ_BRANCH.replaceAll('[^a-zA-Z0-9]', '-')
					def sha = (env.GIT_COMMIT ?: 'ukjent').take(7)
					env.IMAGE_TAG = "${env.BUILD_NUMBER}-${sha}${suffix}"
					env.IMAGE_REF = "${DOCKER_REGISTRY}/${IMAGE_NAME}"

					echo "Branch:  ${env.EPJ_BRANCH} (hovedlinje: ${env.EPJ_IS_MAIN})"
					echo "Commit:  ${env.GIT_COMMIT}"
					echo "Image:   ${env.IMAGE_REF}:${env.IMAGE_TAG}"
				}
			}
		}

		// What fails most often, first.
		stage('Types and build') {
			steps {
				sh '''
					docker run --rm \
						-v "$PWD":/w -w /w \
						-e npm_config_cache=/w/.npm \
						-e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD \
						-e EPJ_DATA_KEY -e EPJ_ORG_HER_ID -e EPJ_ORG_NUMBER -e EPJ_INTEGRATION_MODE \
						"$NODE_IMAGE" \
						sh -c "npm ci && npm run check && npm run build"
				'''
			}
		}

		stage('Tests') {
			steps {
				script {
					def net = "epj-ci-${env.BUILD_NUMBER}"
					def pg = "epj-pg-${env.BUILD_NUMBER}"
					try {
						// Postgres beside the tests, reachable under the name the
						// Woodpecker pipeline uses, so the connection string matches.
						sh "docker network create ${net}"
						sh """
							docker run -d --name ${pg} --network ${net} --network-alias postgres \
								-e POSTGRES_USER=epj -e POSTGRES_PASSWORD=epj -e POSTGRES_DB=epj \
								"\$POSTGRES_IMAGE"
						"""
						sh """
							docker run --rm --network ${net} \
								-v "\$PWD":/w -w /w \
								-e npm_config_cache=/w/.npm \
								-e EPJ_TEST_DATABASE_URL=postgres://epj:epj@postgres:5432/postgres \
								-e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD \
								-e EPJ_DATA_KEY -e EPJ_ORG_HER_ID -e EPJ_ORG_NUMBER -e EPJ_INTEGRATION_MODE \
								"\$NODE_IMAGE" \
								sh -c "npm ci && until nc -z postgres 5432; do sleep 1; done && npm test"
						"""
					} finally {
						sh "docker rm -f ${pg} || true"
						sh "docker network rm ${net} || true"
					}
				}
			}
		}

		stage('Build image') {
			steps {
				sh '''
					docker build \
						-f docker/Dockerfile \
						--build-arg EPJ_VERSION="$IMAGE_TAG" \
						-t "$IMAGE_REF:$IMAGE_TAG" \
						.
				'''
				script {
					// `latest` only from the main line. A branch build that claimed
					// it would be deployed by anything following the tag.
					if (env.EPJ_IS_MAIN == 'true') {
						sh 'docker tag "$IMAGE_REF:$IMAGE_TAG" "$IMAGE_REF:latest"'
					}
				}
			}
		}

		stage('Push image') {
			steps {
				script {
					docker.withRegistry("https://${DOCKER_REGISTRY}", "${REGISTRY_CREDENTIALS}") {
						sh 'docker push "$IMAGE_REF:$IMAGE_TAG"'
						if (env.EPJ_IS_MAIN == 'true') {
							sh 'docker push "$IMAGE_REF:latest"'
						}
					}
				}
			}
		}

		stage('Update manifest') {
			when { expression { env.EPJ_IS_MAIN == 'true' } }
			steps {
				withCredentials([usernamePassword(
					credentialsId: "${K8S_CREDENTIALS}",
					usernameVariable: 'GIT_USERNAME',
					passwordVariable: 'GIT_PASSWORD'
				)]) {
					// Everything the script needs is already in the environment, so
					// nothing is interpolated into the shell by Groovy and no secret
					// is ever part of a command line.
					sh '''#!/bin/bash
						set -euo pipefail

						rm -rf manifester
						# The helper hands the credentials to git over a pipe. They
						# never appear in the URL, so they stay out of the log.
						helper='!f() { echo "username=$GIT_USERNAME"; echo "password=$GIT_PASSWORD"; }; f'
						git -c credential.helper= -c credential.helper="$helper" \
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
							sed -i "s|image: $IMAGE_REF:.*|image: $IMAGE_REF:$IMAGE_TAG|g" "$fil"
							git add "$fil"
						done

						if git diff --staged --quiet; then
							echo "Manifestet peker allerede på $IMAGE_TAG. Ingenting å gjøre."
						else
							git diff --staged
							git commit -m "Deploy $APP_NAME $IMAGE_TAG (bygg #$BUILD_NUMBER)"
							git -c credential.helper= -c credential.helper="$helper" \
								push origin "HEAD:$K8S_BRANCH"
						fi

						cd - > /dev/null
						rm -rf manifester
					'''
				}
			}
		}
	}

	post {
		always {
			// The tag is unique per build, so nothing here is worth keeping.
			sh 'docker rmi "$IMAGE_REF:$IMAGE_TAG" || true'
			sh 'docker rmi "$IMAGE_REF:latest" || true'
			cleanWs()
		}
		success {
			script {
				echo "Publisert: ${env.IMAGE_REF}:${env.IMAGE_TAG}"
				if (env.EPJ_IS_MAIN == 'true') {
					echo "Manifestet i ${K8S_REPO}/${K8S_YAML_PATH} er oppdatert. ArgoCD tar resten."
				} else {
					echo "Manifestet er ikke rørt - det skjer bare fra hovedlinjen."
				}
			}
		}
		failure {
			emailext(
				to: 'lars@roland.bz',
				subject: "[FAILURE] ${env.JOB_NAME} bygg #${env.BUILD_NUMBER}",
				body: "${env.BUILD_URL}\n\nGren: ${env.EPJ_BRANCH ?: 'ukjent'}"
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
// If Jenkins becomes the only pipeline, add a stage on the same pattern as
// Tests, using mcr.microsoft.com/playwright and E2E_DATABASE_URL against the
// same Postgres, gated on the main line so branch builds stay quick.
//
// Running on Kubernetes. If this Jenkins ever moves to the Kubernetes plugin,
// the `docker run` steps become containers in a pod template and the image
// build needs kaniko or buildkit - there is no Docker socket in a pod.
// `deploy/apus/bygg.sh` already does a kaniko build and is worth reading first.
// ---------------------------------------------------------------------------
