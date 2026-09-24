package main

import "sync"

// poolMap runs work for every index in [0,n) with at most `workers` goroutines
// in flight at once, and returns when all of them have finished.
//
// Four call sites used to hand-roll this loop (a semaphore channel, a WaitGroup,
// a per-index goroutine). Beyond the duplication, hand-rolling made it easy to
// get the two things that actually matter here subtly wrong:
//
//   - Results go into per-index slots, so no two goroutines ever append to the
//     same slice. Index alignment is also what lets a caller pair a result with
//     the input it came from (and report an error against the right name).
//   - work must not touch anything the caller reads after poolMap returns until
//     it is done — poolMap is the only synchronisation point.
//
// The bound matters for real use: a registry with hundreds of repositories
// would otherwise open hundreds of simultaneous TLS connections and get rate
// limited (or trip the server's connection limit) instead of going faster.
func poolMap(workers, n int, work func(i int)) {
	if n <= 0 {
		return
	}
	if workers < 1 {
		workers = 1
	}
	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			work(i)
		}(i)
	}
	wg.Wait()
}
