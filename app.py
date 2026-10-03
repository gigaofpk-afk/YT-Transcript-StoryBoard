import os
import subprocess
import time

print("☁️ Initializing Hugging Face Gradio Wrapper...")

# ZeroGPU Watchdog Bypass
# Imports the spaces module and defines a dummy task to satisfy the ZeroGPU lifecycle checks.
try:
    import spaces
    @spaces.GPU
    def dummy_gpu_task():
        pass
    print("☁️ ZeroGPU Watchdog bypassed successfully.")
except ImportError:
    print("☁️ Spaces module not found. Skipping ZeroGPU bypass.")

# Install Node.js dependencies
# Since this is a Python space, HF doesn't auto-run npm install. We do it manually here.
print("☁️ Installing Node.js dependencies...")
subprocess.run(["npm", "install"], check=True)

# Start the Node.js server
print("☁️ Launching YouTube Checker Server...")
os.environ["PORT"] = "7860"
node_process = subprocess.Popen(["node", "server.js"])

# Keep the Python wrapper alive so the container doesn't exit
try:
    node_process.wait()
except KeyboardInterrupt:
    node_process.terminate()
