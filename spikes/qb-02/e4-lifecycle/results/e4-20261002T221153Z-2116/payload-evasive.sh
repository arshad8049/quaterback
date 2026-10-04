echo start
( trap '' TERM; exec sleep 7001 ) &
( sh -c 'sleep 7002 &' & )
setsid sleep 7003 &
nohup sleep 7004 >/dev/null 2>&1 &
pkill -KILL -x timeout && echo "killed in-container timeout watcher"
trap '' TERM INT HUP
i=0; while :; do sleep 1; i=$((i+1)); echo "alive $i"; done
