source /home/ives/.copilot_here.sh
copilot_yolo \
  --mount-rw /home/ives/.copilot/mcp-config.json:/home/appuser/.copilot/mcp-config.json \
  --mount-rw /home/ives/.copilot/.mcp-servers:/home/appuser/.copilot/.mcp-servers \
  --mount /home/ives/.ssh:/home/appuser/.ssh  --model claude-sonnet-4.6
